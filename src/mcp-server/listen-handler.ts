// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Node-side orchestrator for the ppal-listen tool.
 * Coordinates V8 recording, file reading, and Gemini API calls.
 */

import fs from "node:fs/promises";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CallLiveApiFunction } from "./create-mcp-server.ts";
import { getListenConfig } from "./listen-config.ts";
import * as console from "./node-for-max-logger.ts";

const DEFAULT_PROMPT =
  "You are analyzing audio for a music producer. " +
  "Describe what you hear: instruments, timbre/character of each sound, " +
  "frequency balance, dynamics, stereo placement, and overall mood. " +
  "Be specific and use production terminology.";

const MAX_DURATION_MS = 120_000; // 2 minutes max recording

interface ListenArgs {
  duration?: string;
  prompt?: string;
  trackIndex?: number;
  sceneIndex?: number;
  model?: string;
}

interface ListenStartResult {
  trackIndex: number;
  sceneIndex: number;
  durationMs: number;
  tempo: number;
}

interface ListenStopResult {
  filePath: string;
  clipId: string;
}

interface McpResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

interface GeminiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

/**
 * Handle the ppal-listen tool call.
 * Orchestrates: start recording → wait → stop → read WAV → call Gemini → return text.
 * @param callLiveApi - Function to call V8 tools
 * @param args - Tool arguments
 * @returns MCP tool result with Gemini's audio description
 */
export async function handleListen(
  callLiveApi: CallLiveApiFunction,
  args: ListenArgs,
): Promise<CallToolResult> {
  const { geminiKey, geminiModel } = getListenConfig();

  if (!geminiKey) {
    return errorResult(
      "Gemini API key is not configured. " +
        "Set it in the Producer Pal device settings.",
    );
  }

  const duration = args.duration ?? "4:0";

  // Step 1: Start recording via V8
  const startResponse = (await callLiveApi("ppal-listen-start", {
    trackIndex: args.trackIndex,
    sceneIndex: args.sceneIndex,
    duration,
  })) as McpResponse;

  if (startResponse.isError) {
    return startResponse as CallToolResult;
  }

  const startResult = parseV8Result<ListenStartResult>(startResponse);

  if (!startResult) {
    return errorResult("Failed to parse listen-start result");
  }

  if (startResult.durationMs > MAX_DURATION_MS) {
    return errorResult(
      `Duration too long: ${Math.round(startResult.durationMs / 1000)}s exceeds max ${MAX_DURATION_MS / 1000}s`,
    );
  }

  console.info(
    `Recording ${duration} (${Math.round(startResult.durationMs)}ms) ` +
      `at ${startResult.tempo} BPM on track ${startResult.trackIndex}`,
  );

  // Step 2: Wait for recording duration
  await sleep(startResult.durationMs);

  // Step 3: Stop recording via V8
  const stopResponse = (await callLiveApi("ppal-listen-stop", {
    trackIndex: startResult.trackIndex,
    sceneIndex: startResult.sceneIndex,
  })) as McpResponse;

  if (stopResponse.isError) {
    return stopResponse as CallToolResult;
  }

  const stopResult = parseV8Result<ListenStopResult>(stopResponse);

  if (!stopResult) {
    return errorResult("Failed to parse listen-stop result");
  }

  console.info(`Recorded to: ${stopResult.filePath}`);

  // Step 4: Read the WAV file (clip was deleted in V8 to release Ableton's lock)
  // Small delay for the OS to release the file handle
  await sleep(1000);

  let wavBuffer: Buffer;

  try {
    wavBuffer = await fs.readFile(stopResult.filePath);
  } catch (error) {
    return errorResult(
      `Failed to read audio file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const wavBase64 = wavBuffer.toString("base64");

  console.info(
    `Audio file: ${Math.round(wavBuffer.length / 1024)}KB, sending to Gemini`,
  );

  // Step 5: Call Gemini API
  const prompt = args.prompt ?? DEFAULT_PROMPT;

  try {
    const description = await callGemini(
      geminiKey,
      wavBase64,
      prompt,
      args.model ?? geminiModel,
    );

    return {
      content: [{ type: "text", text: description }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Return file path as fallback so user can still access the recording
    return errorResult(
      `Gemini API call failed: ${message}\n` +
        `Recording saved at: ${stopResult.filePath}`,
    );
  }
}

/**
 * Call the Gemini API with audio data and a prompt.
 * Uses raw fetch to avoid bundling the @google/genai SDK.
 * @param apiKey - Gemini API key
 * @param audioBase64 - Base64-encoded WAV audio
 * @param prompt - Text prompt for audio analysis
 * @param modelOverride - Optional model name override
 * @returns Gemini's text response
 */
async function callGemini(
  apiKey: string,
  audioBase64: string,
  prompt: string,
  modelOverride: string,
): Promise<string> {
  const model = modelOverride || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              inline_data: {
                mime_type: "audio/wav",
                data: audioBase64,
              },
            },
            { text: prompt },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(`HTTP ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as GeminiResponse;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!text) {
    throw new Error("No text in Gemini response");
  }

  return text;
}

/**
 * Parse the V8 tool result from compact JS literal format.
 * V8 returns `{content:[{type:"text",text:"..."}]}` where text is the serialized result.
 * @param response - MCP response from V8
 * @returns Parsed result object, or null if parsing fails
 */
function parseV8Result<T>(response: McpResponse): T | null {
  try {
    const text = response.content[0]?.text;

    if (!text) return null;

    // The V8 response text is in compact JS literal format.
    // Only keys are unquoted (values are JSON-safe); quote the keys to parse as JSON.
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

/**
 * Sleep for a given duration.
 * @param ms - Milliseconds to sleep
 * @returns Promise that resolves after the duration
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
