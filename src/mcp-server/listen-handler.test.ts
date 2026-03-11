// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CallLiveApiFunction } from "../create-mcp-server.ts";
import { handleListen } from "../listen-handler.ts";

// Mock listen-config so we can control getListenConfig()
vi.mock(import("../listen-config.ts"), () => ({
  getListenConfig: vi.fn(() => ({
    geminiKey: "test-api-key",
    geminiModel: "gemini-2.5-flash",
  })),
}));

// Mock node:fs/promises, spreading original to satisfy module shape type check
vi.mock(import("node:fs/promises"), async (importOriginal) => {
  const original = await importOriginal();

  return {
    ...original,
    default: { ...original.default, readFile: vi.fn() },
  };
});

// Mock node-for-max-logger to avoid Max.post side effects
vi.mock(import("../node-for-max-logger.ts"), () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

import { getListenConfig } from "../listen-config.ts";
import fs from "node:fs/promises";

const mockGetListenConfig = vi.mocked(getListenConfig);

const mockReadFile = fs.readFile as unknown as {
  mockResolvedValue: (v: Buffer) => void;
  mockRejectedValue: (e: unknown) => void;
};

/**
 * Build a mock start response in compact JS literal format.
 * @param trackIndex - Track index
 * @param sceneIndex - Scene index
 * @param durationMs - Duration in milliseconds
 * @param tempo - BPM tempo
 * @returns Mock MCP response object
 */
function makeStartResponse(
  trackIndex = 0,
  sceneIndex = 0,
  durationMs = 4000,
  tempo = 120,
): object {
  const text = `{trackIndex:${trackIndex},sceneIndex:${sceneIndex},durationMs:${durationMs},tempo:${tempo}}`;

  return { content: [{ type: "text", text }], isError: false };
}

/**
 * Build a mock stop response.
 * @param filePath - Path to the recorded WAV file
 * @param clipId - Clip ID returned by V8
 * @returns Mock MCP response object
 */
function makeStopResponse(
  filePath = "/tmp/recording.wav",
  clipId = "clip1",
): object {
  const text = `{filePath:${JSON.stringify(filePath)},clipId:${JSON.stringify(clipId)}}`;

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

// Gemini candidate response for a single text part
const geminiOkResponse = (text: string) => ({
  ok: true,
  json: vi.fn().mockResolvedValue({
    candidates: [{ content: { parts: [{ text }] } }],
  }),
});

describe("handleListen", () => {
  let callLiveApi: ReturnType<typeof vi.fn> & CallLiveApiFunction;

  beforeEach(() => {
    vi.useFakeTimers();
    callLiveApi = vi.fn() as ReturnType<typeof vi.fn> & CallLiveApiFunction;
    mockGetListenConfig.mockReturnValue({
      geminiKey: "test-api-key",
      geminiModel: "gemini-2.5-flash",
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Set up default mocks for a successful end-to-end flow.
   * Configures callLiveApi start/stop, file read, and Gemini fetch.
   * @param geminiText - Text returned by Gemini
   * @param startArgs - Override args for makeStartResponse
   * @param stopArgs - Override args for makeStopResponse
   * @returns The mocked fetch function for further assertions
   */
  function setupSuccessfulFlow(
    geminiText = "Description.",
    startArgs: Parameters<typeof makeStartResponse> = [],
    stopArgs: Parameters<typeof makeStopResponse> = [],
  ): ReturnType<typeof vi.fn> {
    callLiveApi
      .mockResolvedValueOnce(makeStartResponse(...startArgs))
      .mockResolvedValueOnce(makeStopResponse(...stopArgs));
    mockReadFile.mockResolvedValue(
      Buffer.alloc(10 * 1024, 0) as unknown as Buffer,
    );
    const mockFetch = vi.fn().mockResolvedValue(geminiOkResponse(geminiText));

    vi.stubGlobal("fetch", mockFetch);

    return mockFetch;
  }

  /**
   * Get the URL from the first fetch call.
   * @param mockFetch - Mocked fetch function
   * @returns The URL string
   */
  function getFetchUrl(mockFetch: ReturnType<typeof vi.fn>): string {
    return (mockFetch.mock.calls[0] as [string])[0];
  }

  /**
   * Get the parsed body from the first fetch call.
   * @param mockFetch - Mocked fetch function
   * @returns The parsed request body object
   */
  function getFetchBody(mockFetch: ReturnType<typeof vi.fn>): unknown {
    return JSON.parse(
      (mockFetch.mock.calls[0] as [string, { body: string }])[1].body,
    );
  }

  describe("missing Gemini API key", () => {
    it("returns error when geminiKey is empty", async () => {
      mockGetListenConfig.mockReturnValue({ geminiKey: "", geminiModel: "" });
      const result = await handleListen(callLiveApi, {});

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
        "Gemini API key is not configured",
      );
      expect(callLiveApi).not.toHaveBeenCalled();
    });
  });

  describe("listen-start errors", () => {
    it("returns the start error response when listen-start fails", async () => {
      callLiveApi.mockResolvedValue(makeErrorResponse("Track not found"));
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Track not found",
      );
    });

    it("returns error when start result cannot be parsed", async () => {
      callLiveApi.mockResolvedValue({
        content: [{ type: "text", text: "not parseable" }],
        isError: false,
      });
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      // Verify the handler doesn't crash on unparseable input
      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });

    it("returns error when durationMs exceeds 2-minute max", async () => {
      callLiveApi.mockResolvedValue(makeStartResponse(0, 0, 130_000, 120));
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(text).toContain("Duration too long");
      expect(text).toContain("130s");
    });

    it("returns error when start response content is empty", async () => {
      callLiveApi.mockResolvedValue({ content: [], isError: false });
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Failed to parse listen-start result",
      );
    });
  });

  describe("listen-stop errors", () => {
    it("returns stop error response when listen-stop fails", async () => {
      callLiveApi
        .mockResolvedValueOnce(makeStartResponse(0, 0, 2000, 120))
        .mockResolvedValueOnce(makeErrorResponse("Stop failed"));
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Stop failed",
      );
    });

    it("returns error when stop result cannot be parsed", async () => {
      callLiveApi
        .mockResolvedValueOnce(makeStartResponse(0, 0, 2000, 120))
        .mockResolvedValueOnce({ content: [], isError: false });
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "Failed to parse listen-stop result",
      );
    });
  });

  describe("file read errors", () => {
    it("returns error when file cannot be read", async () => {
      callLiveApi
        .mockResolvedValueOnce(makeStartResponse(0, 0, 2000, 120))
        .mockResolvedValueOnce(makeStopResponse("/tmp/recording.wav"));
      mockReadFile.mockRejectedValue(new Error("ENOENT: file not found"));
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(text).toContain("Failed to read audio file");
      expect(text).toContain("ENOENT");
    });

    it("handles non-Error thrown during file read", async () => {
      callLiveApi
        .mockResolvedValueOnce(makeStartResponse(0, 0, 2000, 120))
        .mockResolvedValueOnce(makeStopResponse("/tmp/recording.wav"));
      mockReadFile.mockRejectedValue("string error");
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(text).toContain("Failed to read audio file");
      expect(text).toContain("string error");
    });
  });

  describe("Gemini API call errors", () => {
    // Shared setup: recording succeeds, Gemini call is what varies
    beforeEach(() => {
      callLiveApi
        .mockResolvedValueOnce(makeStartResponse(0, 0, 2000, 120))
        .mockResolvedValueOnce(makeStopResponse("/tmp/recording.wav"));
      mockReadFile.mockResolvedValue(Buffer.alloc(1024) as unknown as Buffer);
    });

    it("returns error with file path fallback when Gemini call fails", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new Error("Network error")),
      );
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;
      const text = (result.content as Array<{ text: string }>)[0]!.text;

      expect(result.isError).toBe(true);
      expect(text).toContain("Gemini API call failed");
      expect(text).toContain("Network error");
      expect(text).toContain("/tmp/recording.wav");
    });

    it("returns error when Gemini returns HTTP error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: false,
          status: 403,
          text: vi.fn().mockResolvedValue("Forbidden"),
        }),
      );
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
        "HTTP 403",
      );
    });

    it("returns error when Gemini response has no text content", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({}),
        }),
      );
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
        "No text in Gemini response",
      );
    });

    it("returns error when Gemini response has empty candidates", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          json: vi.fn().mockResolvedValue({ candidates: [] }),
        }),
      );
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
    });

    it("handles non-Error thrown from Gemini", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue("network timeout"));
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]!.text).toContain(
        "network timeout",
      );
    });
  });

  describe("successful flow", () => {
    it("returns Gemini description on success", async () => {
      setupSuccessfulFlow("A lush pad with warm mid-range character.");
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBeUndefined();
      expect((result.content as Array<{ text: string }>)[0]!.text).toBe(
        "A lush pad with warm mid-range character.",
      );
    });

    it("passes default duration '4:0' when args.duration not provided", async () => {
      setupSuccessfulFlow();
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith(
        "ppal-listen-start",
        expect.objectContaining({ duration: "4:0" }),
      );
    });

    it("passes custom duration to listen-start", async () => {
      setupSuccessfulFlow("Drums.", [0, 0, 8000, 120]);
      const promise = handleListen(callLiveApi, { duration: "8:0" });

      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith(
        "ppal-listen-start",
        expect.objectContaining({ duration: "8:0" }),
      );
    });

    it("passes trackIndex and sceneIndex to listen-start", async () => {
      setupSuccessfulFlow("Bass.", [2, 3, 4000, 140]);
      const promise = handleListen(callLiveApi, {
        trackIndex: 2,
        sceneIndex: 3,
      });

      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith("ppal-listen-start", {
        trackIndex: 2,
        sceneIndex: 3,
        duration: "4:0",
      });
    });

    it("uses trackIndex/sceneIndex from start result for stop call", async () => {
      setupSuccessfulFlow("Sound.", [2, 3, 4000, 120]);
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      expect(callLiveApi).toHaveBeenCalledWith("ppal-listen-stop", {
        trackIndex: 2,
        sceneIndex: 3,
      });
    });

    it("uses custom prompt when provided", async () => {
      const mockFetch = setupSuccessfulFlow("Analysis.");
      const promise = handleListen(callLiveApi, {
        prompt: "Analyze the kick drum.",
      });

      await vi.runAllTimersAsync();
      await promise;

      const body = getFetchBody(mockFetch) as {
        contents: [{ parts: [unknown, { text: string }] }];
      };

      expect(body.contents[0].parts[1].text).toBe("Analyze the kick drum.");
    });

    it("uses model override from args", async () => {
      const mockFetch = setupSuccessfulFlow("Analysis.");
      const promise = handleListen(callLiveApi, { model: "gemini-2.0-flash" });

      await vi.runAllTimersAsync();
      await promise;

      expect(getFetchUrl(mockFetch)).toContain("gemini-2.0-flash");
    });

    it("uses geminiModel from config when no model arg provided", async () => {
      mockGetListenConfig.mockReturnValue({
        geminiKey: "key",
        geminiModel: "gemini-pro-config",
      });
      const mockFetch = setupSuccessfulFlow("Analysis.");
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      expect(getFetchUrl(mockFetch)).toContain("gemini-pro-config");
    });

    it("falls back to gemini-2.5-flash when no model in args or config", async () => {
      mockGetListenConfig.mockReturnValue({
        geminiKey: "key",
        geminiModel: "",
      });
      const mockFetch = setupSuccessfulFlow("Analysis.");
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      expect(getFetchUrl(mockFetch)).toContain("gemini-2.5-flash");
    });

    it("includes audio as base64 in the Gemini request body", async () => {
      const wavData = Buffer.from([0x52, 0x49, 0x46, 0x46]); // "RIFF"

      callLiveApi
        .mockResolvedValueOnce(makeStartResponse())
        .mockResolvedValueOnce(makeStopResponse());
      mockReadFile.mockResolvedValue(wavData as unknown as Buffer);
      const mockFetch = vi.fn().mockResolvedValue(geminiOkResponse("Audio."));

      vi.stubGlobal("fetch", mockFetch);
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      const body = getFetchBody(mockFetch) as {
        contents: [
          { parts: [{ inline_data: { data: string; mime_type: string } }] },
        ];
      };

      expect(body.contents[0].parts[0].inline_data.data).toBe(
        wavData.toString("base64"),
      );
      expect(body.contents[0].parts[0].inline_data.mime_type).toBe("audio/wav");
    });

    it("calls fetch with API key in URL", async () => {
      mockGetListenConfig.mockReturnValue({
        geminiKey: "my-secret-key",
        geminiModel: "",
      });
      const mockFetch = setupSuccessfulFlow("Done.");
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      await promise;

      const url = getFetchUrl(mockFetch);

      expect(url).toContain("key=my-secret-key");
      expect(url).toContain("generativelanguage.googleapis.com");
    });

    it("waits for recording duration before stopping", async () => {
      setupSuccessfulFlow("Done.", [0, 0, 5000, 120]);
      const promise = handleListen(callLiveApi, {});

      await vi.advanceTimersByTimeAsync(0);
      expect(callLiveApi).toHaveBeenCalledTimes(1);

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(callLiveApi).toHaveBeenCalledTimes(2);
      expect(result.isError).toBeUndefined();
    });
  });

  describe("parseV8Result edge cases", () => {
    it("handles V8 compact JS literal format successfully", async () => {
      callLiveApi.mockResolvedValueOnce({
        content: [
          {
            type: "text",
            text: "{trackIndex:1,sceneIndex:2,durationMs:3000,tempo:140}",
          },
        ],
        isError: false,
      });
      callLiveApi.mockResolvedValueOnce(makeStopResponse("/some/path.wav"));
      mockReadFile.mockResolvedValue(Buffer.alloc(1024) as unknown as Buffer);
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(geminiOkResponse("Good.")),
      );
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result.isError).toBeUndefined();
    });

    it("handles JSON parse failure gracefully", async () => {
      callLiveApi.mockResolvedValueOnce({
        content: [{ type: "text", text: "{invalid: json: content}" }],
        isError: false,
      });
      const promise = handleListen(callLiveApi, {});

      await vi.runAllTimersAsync();
      const result = await promise;

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
    });
  });
});
