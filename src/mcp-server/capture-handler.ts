// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Node-side orchestrator for the ppal-capture tool.
 * Coordinates V8 routing setup, capture device communication, and returns WAV path.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import Max from "max-api";
import { type CallLiveApiFunction } from "./create-mcp-server.ts";
import * as console from "./node-for-max-logger.ts";

const MAX_DURATION_MS = 120_000; // 2 minutes max recording

interface CaptureArgs {
  duration?: string;
  source?: number | "master";
}

interface CaptureStartResult {
  captureTrackIndex: number;
  durationMs: number;
  tempo: number;
  sourceName: string;
  projectName: string;
}

interface CaptureStoppedResult {
  filePath: string;
  durationMs: number;
}

interface McpResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface PendingCapture {
  resolve: (result: CaptureStoppedResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// captureState holds the concurrent-call guard and the pending device callback.
// isLocked is set synchronously before any await; both fields cleared in finally.
const captureState = {
  isLocked: false,
  pending: null as PendingCapture | null,
};

/** Release the capture lock. Called from handleCapture's finally block. */
function releaseCaptureState(): void {
  captureState.isLocked = false;
  captureState.pending = null; // safety net — handlers clear it normally
}

Max.addHandler("capture_stopped", (jsonStr: unknown) => {
  if (!captureState.pending) return;

  const { resolve, timeout } = captureState.pending;

  clearTimeout(timeout);
  captureState.pending = null;

  try {
    const data = JSON.parse(String(jsonStr)) as CaptureStoppedResult;

    resolve(data);
  } catch {
    resolve({ filePath: String(jsonStr), durationMs: 0 });
  }
});

Max.addHandler("capture_error", (jsonStr: unknown) => {
  if (!captureState.pending) return;

  const { reject, timeout } = captureState.pending;

  clearTimeout(timeout);
  captureState.pending = null;

  try {
    const data = JSON.parse(String(jsonStr)) as { error: string };

    reject(new Error(data.error));
  } catch {
    reject(new Error(String(jsonStr)));
  }
});

/**
 * Handle the ppal-capture tool call.
 * Coordinates: routing setup (V8) → capture_start (device) → await capture_stopped → return file path.
 * @param callLiveApi - Function to call V8 tools
 * @param sampleFolder - Configured sample folder path (or empty string if not set)
 * @param args - Tool arguments
 * @returns MCP tool result with the captured WAV file path
 */
export async function handleCapture(
  callLiveApi: CallLiveApiFunction,
  sampleFolder: string,
  args: CaptureArgs,
): Promise<CallToolResult> {
  // Guard: set synchronously before any await so no concurrent call can slip through.
  if (captureState.isLocked) {
    return errorResult(
      "A capture is already in progress. Wait for it to complete.",
    );
  }

  captureState.isLocked = true;

  try {
    // Step 1: Set up routing via V8 (find/create capture track, configure I/O)
    const startResponse = (await callLiveApi("ppal-capture-start", {
      duration: args.duration,
      source: args.source,
    })) as McpResponse;

    if (startResponse.isError) {
      return startResponse as CallToolResult;
    }

    const startResult = parseV8Result<CaptureStartResult>(startResponse);

    if (!startResult) {
      return errorResult("Failed to parse capture-start result");
    }

    if (startResult.durationMs > MAX_DURATION_MS) {
      return errorResult(
        `Duration too long: ${Math.round(startResult.durationMs / 1000)}s exceeds max ${MAX_DURATION_MS / 1000}s`,
      );
    }

    console.info(
      `Capturing ${args.duration ?? "4:0"} (${Math.round(startResult.durationMs)}ms) ` +
        `at ${startResult.tempo} BPM on track ${startResult.captureTrackIndex}`,
    );

    // Step 2: Resolve output path (persistent sampleFolder or tmpdir fallback)
    const outputPath = await resolveOutputPath(
      sampleFolder,
      startResult.projectName,
      startResult.sourceName,
      startResult.durationMs,
      startResult.tempo,
    );

    // Step 3: Register capture_stopped listener BEFORE sending capture_start.
    // The listener must be in place first to avoid a race where the device responds
    // before the handler is registered.
    const capturePromise = new Promise<CaptureStoppedResult>(
      (resolve, reject) => {
        const timeout = setTimeout(() => {
          captureState.pending = null;
          reject(
            new Error(
              `Capture timed out after ${startResult.durationMs + 5000}ms — ` +
                `is the ppal-capture.amxd device on the _PP Capture track?`,
            ),
          );
        }, startResult.durationMs + 5000);

        captureState.pending = { resolve, reject, timeout };
      },
    );

    // Step 4: Send capture_start to the device (listener is already registered above)
    await Max.outlet(
      "capture_cmd",
      JSON.stringify({
        action: "capture_start",
        durationMs: startResult.durationMs,
        outputPath,
      }),
    );

    // Step 5: Await device completion (no sleep — device signals when done)
    const result = await capturePromise;

    console.info(`Captured to: ${result.filePath}`);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            filePath: result.filePath,
            durationMs: result.durationMs,
            tempo: startResult.tempo,
            source: startResult.sourceName,
          }),
        },
      ],
    };
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  } finally {
    releaseCaptureState();
  }
}

/**
 * Resolve the output WAV path for a capture.
 * If a sample folder is configured, writes to {sampleFolder}/captures/{project}/ with a
 * descriptive name. Falls back to os.tmpdir() if no sample folder is set.
 * @param sampleFolder - Configured sample folder path, or empty string
 * @param projectName - Live Set project name (used as subdirectory)
 * @param sourceName - Resolved source name ("master" or track name)
 * @param durationMs - Recording duration in milliseconds
 * @param tempo - Session tempo in BPM at capture time
 * @returns Absolute path for the output WAV file
 */
async function resolveOutputPath(
  sampleFolder: string,
  projectName: string,
  sourceName: string,
  durationMs: number,
  tempo: number,
): Promise<string> {
  const filename = buildCaptureFilename(sourceName, durationMs, tempo);

  if (sampleFolder) {
    const safeProject = sanitizeName(projectName) || "unnamed";
    const capturesDir = path.join(sampleFolder, "captures", safeProject);

    await fs.mkdir(capturesDir, { recursive: true });

    return path.join(capturesDir, filename);
  }

  return path.join(os.tmpdir(), filename);
}

/**
 * Build a descriptive filename for a captured WAV.
 * Format: capture-{source}-{bars}bars-{tempo}bpm-{YYYYMMDD-HHmmss}.wav
 * @param sourceName - Source name ("master" or track name)
 * @param durationMs - Recording duration in milliseconds
 * @param tempo - Session tempo in BPM
 * @returns Filename string (no directory component)
 */
export function buildCaptureFilename(
  sourceName: string,
  durationMs: number,
  tempo: number,
): string {
  const bars = Math.max(1, Math.round(((durationMs / 60_000) * tempo) / 4));
  const source = sanitizeName(sourceName) || "unknown";
  const now = new Date();
  const datetime =
    `${now.getFullYear()}` +
    `${String(now.getMonth() + 1).padStart(2, "0")}` +
    `${String(now.getDate()).padStart(2, "0")}` +
    `-${String(now.getHours()).padStart(2, "0")}` +
    `${String(now.getMinutes()).padStart(2, "0")}` +
    `${String(now.getSeconds()).padStart(2, "0")}`;

  return `capture-${source}-${bars}bars-${Math.round(tempo)}bpm-${datetime}.wav`;
}

/**
 * Lowercase a name and replace non-alphanumeric runs with hyphens.
 * @param name - Raw name to sanitize
 * @returns Kebab-case string safe for filenames and directory names
 */
function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replaceAll(/[^\da-z]+/g, "-")
    .replaceAll(/^-|-$/g, "");
}

/**
 * Parse the V8 tool result from compact JS literal format.
 * @param response - MCP response from V8
 * @returns Parsed result object, or null if parsing fails
 */
function parseV8Result<T>(response: McpResponse): T | null {
  try {
    const text = response.content[0]?.text;

    if (!text) return null;

    const jsonText = text.replaceAll(
      /([,{]\s*)([$A-Z_a-z][\w$]*)\s*:/g,
      '$1"$2":',
    );

    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

/**
 * Create an error result.
 * @param message - Error message
 * @returns MCP error result
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
