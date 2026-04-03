// Producer Pal
// Copyright (C) 2026 Adam Murray
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallLiveApiFunction } from "../create-mcp-server.ts";
import { buildCaptureFilename, handleCapture } from "../capture-handler.ts";

// Hoist mockMkdir so it is available when vi.mock factory runs
const { mockMkdir } = vi.hoisted(() => ({
  mockMkdir: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs/promises so mkdir resolves synchronously in microtasks (no real I/O)
vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();

  return { ...actual, default: { ...actual.default, mkdir: mockMkdir } };
});

// Mock node-for-max-logger to avoid Max.post side effects
vi.mock(import("../node-for-max-logger.ts"), () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

// Access the global Max mock from test-setup.ts
const mockMax = (globalThis as Record<string, unknown>).Max as {
  handlers: Map<string, (...args: unknown[]) => void>;
  outlet: ReturnType<typeof vi.fn>;
};

const emptySampleFolder = "";

/**
 * Build a mock capture-start response in compact JS literal format.
 * @param captureTrackIndex - Track index
 * @param durationMs - Duration in milliseconds
 * @param tempo - BPM tempo
 * @param sourceName - Resolved source name
 * @param projectName - Live Set project name
 * @returns Mock MCP response object
 */
function makeCaptureStartResponse(
  captureTrackIndex = 0,
  durationMs = 8000,
  tempo = 120,
  sourceName = "master",
  projectName = "Test Project",
): object {
  const text =
    `{captureTrackIndex:${captureTrackIndex},durationMs:${durationMs},` +
    `tempo:${tempo},sourceName:"${sourceName}",projectName:"${projectName}"}`;

  return { content: [{ type: "text", text }], isError: false };
}

/**
 * Build an error response.
 * @param message - Error message text
 * @returns Mock MCP error response object
 */
function makeErrorResponse(message: string): object {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Simulate the capture device sending capture_stopped.
 * @param filePath - Captured file path
 * @param durationMs - Actual recorded duration
 */
function triggerCaptureStoppedMessage(
  filePath = "/tmp/ppal-capture-123.wav",
  durationMs = 8000,
): void {
  const handler = mockMax.handlers.get("capture_stopped");

  handler?.(JSON.stringify({ filePath, durationMs }));
}

/**
 * Simulate the capture device sending capture_error.
 * @param error - Error message
 */
function triggerCaptureErrorMessage(error = "buffer~ write failed"): void {
  const handler = mockMax.handlers.get("capture_error");

  handler?.(JSON.stringify({ error }));
}

describe("handleCapture", () => {
  let callLiveApi: ReturnType<typeof vi.fn> & CallLiveApiFunction;

  beforeEach(() => {
    vi.useFakeTimers();
    callLiveApi = vi.fn() as ReturnType<typeof vi.fn> & CallLiveApiFunction;
    // Reset outlet mock to avoid mcp_request auto-reply interfering with capture tests
    mockMax.outlet.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    // Drain any pending capture state so captureState.isLocked is reset between tests.
    // If a test leaves a pending capture, this prevents it from leaking into the next test.
    triggerCaptureStoppedMessage();
    await vi.runAllTimersAsync();
    vi.useRealTimers();
    mockMkdir.mockClear();
  });

  describe("V8 capture-start errors", () => {
    it("returns the V8 error response when capture-start fails", async () => {
      callLiveApi.mockResolvedValue(makeErrorResponse("Track not found"));
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Track not found",
      );
    });

    it("returns error when capture-start result cannot be parsed", async () => {
      callLiveApi.mockResolvedValue({
        content: [],
        isError: false,
      });
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Failed to parse capture-start result",
      );
    });

    it("returns error when durationMs exceeds 2-minute max", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 130_000, 120, "master"),
      );
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(text).toContain("Duration too long");
      expect(text).toContain("130s");
    });
  });

  describe("capture device communication", () => {
    it("sends capture_cmd to Max with action, durationMs, and outputPath", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 8000, 120, "master"),
      );
      const promise = handleCapture(callLiveApi, emptySampleFolder, {
        duration: "4:0",
      });

      // Let the V8 call and resolveOutputPath resolve
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Trigger device completion
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      expect(mockMax.outlet).toHaveBeenCalledWith(
        "capture_cmd",
        expect.stringContaining('"action":"capture_start"'),
      );
      const outletArg = (
        mockMax.outlet.mock.calls.find(
          (call: unknown[]) => call[0] === "capture_cmd",
        ) as [string, string]
      )[1];
      const parsed = JSON.parse(outletArg) as {
        action: string;
        durationMs: number;
        outputPath: string;
      };

      expect(parsed.action).toBe("capture_start");
      expect(parsed.durationMs).toBe(8000);
      expect(parsed.outputPath).toContain("capture-master-");
      expect(parsed.outputPath).toMatch(/\.wav$/);
    });

    it("awaits capture_stopped from device (no sleep)", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 5000, 120, "master"),
      );

      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Outlet should have been called but promise not resolved
      expect(
        mockMax.outlet.mock.calls.some(
          (call: unknown[]) => call[0] === "capture_cmd",
        ),
      ).toBe(true);

      // Trigger device reply
      triggerCaptureStoppedMessage("/tmp/ppal-capture-999.wav", 5000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBeUndefined();
    });

    it("returns filePath, tempo, and source from capture_stopped message", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 8000, 130, "Bass"),
      );
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage("/tmp/ppal-capture-abc.wav", 8000);
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ text: string }>)[0]!.text;
      const data = JSON.parse(text) as {
        filePath: string;
        durationMs: number;
        tempo: number;
        source: string;
      };

      expect(data.filePath).toBe("/tmp/ppal-capture-abc.wav");
      expect(data.durationMs).toBe(8000);
      expect(data.tempo).toBe(130);
      expect(data.source).toBe("Bass");
    });

    it("rejects concurrent calls even before V8 responds", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 8000, 120, "master"),
      );

      // Both calls fired in the same turn — isCaptureLocked blocks the second immediately
      const first = handleCapture(callLiveApi, emptySampleFolder, {});
      const second = await handleCapture(callLiveApi, emptySampleFolder, {});

      expect(second.isError).toBe(true);
      expect((second.content as Array<{ text: string }>)[0]!.text).toContain(
        "already in progress",
      );

      // Clean up first capture
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await first;
    });

    it("returns error when capture device sends capture_error", async () => {
      callLiveApi.mockResolvedValue(makeCaptureStartResponse());
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureErrorMessage("buffer~ write failed: disk full");
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
        "buffer~ write failed: disk full",
      );
    });
  });

  describe("timeout handling", () => {
    it("returns timeout error when device does not respond", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 4000, 120, "master"),
      );
      const promise = handleCapture(callLiveApi, emptySampleFolder, {});

      // Advance past durationMs + 5000 = 9000ms
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(text).toContain("timed out");
      expect(text).toContain("ppal-capture.amxd");
    });
  });

  describe("output path", () => {
    it("uses os.tmpdir() when no sampleFolder configured", async () => {
      callLiveApi.mockResolvedValue(makeCaptureStartResponse());
      const promise = handleCapture(callLiveApi, "", {});

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      const outletArg = (
        mockMax.outlet.mock.calls.find(
          (call: unknown[]) => call[0] === "capture_cmd",
        ) as [string, string]
      )[1];
      const parsed = JSON.parse(outletArg) as { outputPath: string };

      expect(parsed.outputPath.startsWith(os.tmpdir())).toBe(true);
      expect(parsed.outputPath).not.toContain(`${path.sep}captures${path.sep}`);
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it("uses sampleFolder/captures/{project}/ when sampleFolder is configured", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 8000, 120, "master", "My Song"),
      );
      const sampleFolder = os.tmpdir();
      const promise = handleCapture(callLiveApi, sampleFolder, {});

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      const outletArg = (
        mockMax.outlet.mock.calls.find(
          (call: unknown[]) => call[0] === "capture_cmd",
        ) as [string, string]
      )[1];
      const parsed = JSON.parse(outletArg) as { outputPath: string };
      const expectedDir = path.join(sampleFolder, "captures", "my-song");

      expect(parsed.outputPath.startsWith(expectedDir)).toBe(true);
      expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
    });
  });

  describe("tool arguments forwarded to V8", () => {
    it("passes duration to V8 capture-start", async () => {
      callLiveApi.mockResolvedValue(
        makeCaptureStartResponse(0, 16_000, 120, "master"),
      );
      const promise = handleCapture(callLiveApi, emptySampleFolder, {
        duration: "8:0",
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith(
        "ppal-capture-start",
        expect.objectContaining({ duration: "8:0" }),
      );
    });

    it("passes source track index to V8 capture-start", async () => {
      callLiveApi.mockResolvedValue(makeCaptureStartResponse());
      const promise = handleCapture(callLiveApi, emptySampleFolder, {
        source: 3,
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith(
        "ppal-capture-start",
        expect.objectContaining({ source: 3 }),
      );
    });

    it('passes source "master" to V8 capture-start', async () => {
      callLiveApi.mockResolvedValue(makeCaptureStartResponse());
      const promise = handleCapture(callLiveApi, emptySampleFolder, {
        source: "master",
      });

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      triggerCaptureStoppedMessage();
      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith(
        "ppal-capture-start",
        expect.objectContaining({ source: "master" }),
      );
    });
  });
});

describe("buildCaptureFilename", () => {
  beforeEach(() => {
    vi.setSystemTime(new Date("2026-04-01T14:30:22.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('produces correct format for "master" at 120 BPM, 4 bars', () => {
    // 4 bars at 120 BPM: durationMs = (4*4/120)*60000 = 8000ms
    const filename = buildCaptureFilename("master", 8000, 120);

    expect(filename).toMatch(/^capture-master-4bars-120bpm-\d{8}-\d{6}\.wav$/);
  });

  it("sanitises track names to kebab-case", () => {
    const filename = buildCaptureFilename("Bass Synth", 8000, 120);

    expect(filename).toContain("capture-bass-synth-");
  });

  it("strips special characters from track names", () => {
    const filename = buildCaptureFilename("Track 3 (Lead)", 8000, 120);

    expect(filename).toContain("capture-track-3-lead-");
  });

  it("falls back to 'unknown' when name sanitises to empty", () => {
    const filename = buildCaptureFilename("---", 8000, 120);

    expect(filename).toContain("capture-unknown-");
  });

  it("clamps bars to minimum 1 for very short durations", () => {
    // 100ms at 120 BPM ≈ 0.05 bars → rounds to 0 → clamped to 1
    const filename = buildCaptureFilename("master", 100, 120);

    expect(filename).toContain("-1bars-");
  });

  it("rounds tempo in filename", () => {
    const filename = buildCaptureFilename("master", 8000, 128.5);

    expect(filename).toContain("-129bpm-");
  });
});
