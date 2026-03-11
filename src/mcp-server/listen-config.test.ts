// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getListenConfig,
  setGeminiKey,
  setGeminiModel,
} from "../listen-config.ts";

describe("listen-config", () => {
  // Save and restore env vars around each test
  let originalGeminiKey: string | undefined;
  let originalGeminiModel: string | undefined;

  beforeEach(() => {
    originalGeminiKey = process.env.GEMINI_KEY;
    originalGeminiModel = process.env.GEMINI_MODEL;
    // Clear env vars to start fresh
    delete process.env.GEMINI_KEY;
    delete process.env.GEMINI_MODEL;
    // Reset module-level state to empty strings
    setGeminiKey("");
    setGeminiModel("");
  });

  afterEach(() => {
    // Restore env vars
    if (originalGeminiKey !== undefined) {
      process.env.GEMINI_KEY = originalGeminiKey;
    } else {
      delete process.env.GEMINI_KEY;
    }

    if (originalGeminiModel !== undefined) {
      process.env.GEMINI_MODEL = originalGeminiModel;
    } else {
      delete process.env.GEMINI_MODEL;
    }

    // Clean up module-level state
    setGeminiKey("");
    setGeminiModel("");
  });

  describe("getListenConfig", () => {
    it("returns empty strings when nothing is set", () => {
      const config = getListenConfig();

      expect(config.geminiKey).toBe("");
      expect(config.geminiModel).toBe("");
    });

    it("returns key from setGeminiKey when set", () => {
      setGeminiKey("my-api-key");
      const config = getListenConfig();

      expect(config.geminiKey).toBe("my-api-key");
    });

    it("returns model from setGeminiModel when set", () => {
      setGeminiModel("gemini-2.5-flash");
      const config = getListenConfig();

      expect(config.geminiModel).toBe("gemini-2.5-flash");
    });

    it("falls back to GEMINI_KEY env var when key not set via Max", () => {
      process.env.GEMINI_KEY = "env-api-key";
      const config = getListenConfig();

      expect(config.geminiKey).toBe("env-api-key");
    });

    it("falls back to GEMINI_MODEL env var when model not set via Max", () => {
      process.env.GEMINI_MODEL = "gemini-env-model";
      const config = getListenConfig();

      expect(config.geminiModel).toBe("gemini-env-model");
    });

    it("prefers setGeminiKey over env var", () => {
      process.env.GEMINI_KEY = "env-key";
      setGeminiKey("set-key");
      const config = getListenConfig();

      expect(config.geminiKey).toBe("set-key");
    });

    it("prefers setGeminiModel over env var", () => {
      process.env.GEMINI_MODEL = "env-model";
      setGeminiModel("set-model");
      const config = getListenConfig();

      expect(config.geminiModel).toBe("set-model");
    });

    it("returns both key and model when both are set", () => {
      setGeminiKey("key-123");
      setGeminiModel("gemini-pro");
      const config = getListenConfig();

      expect(config.geminiKey).toBe("key-123");
      expect(config.geminiModel).toBe("gemini-pro");
    });

    it("returns a new object each call (does not return the internal state object)", () => {
      setGeminiKey("key");
      const config1 = getListenConfig();
      const config2 = getListenConfig();

      expect(config1).not.toBe(config2);
      expect(config1).toStrictEqual(config2);
    });
  });

  describe("setGeminiKey", () => {
    it("updates the key returned by getListenConfig", () => {
      setGeminiKey("first-key");
      expect(getListenConfig().geminiKey).toBe("first-key");

      setGeminiKey("second-key");
      expect(getListenConfig().geminiKey).toBe("second-key");
    });

    it("allows setting key back to empty string to re-enable env fallback", () => {
      process.env.GEMINI_KEY = "env-key";
      setGeminiKey("explicit-key");
      expect(getListenConfig().geminiKey).toBe("explicit-key");

      setGeminiKey("");
      expect(getListenConfig().geminiKey).toBe("env-key");
    });
  });

  describe("setGeminiModel", () => {
    it("updates the model returned by getListenConfig", () => {
      setGeminiModel("model-v1");
      expect(getListenConfig().geminiModel).toBe("model-v1");

      setGeminiModel("model-v2");
      expect(getListenConfig().geminiModel).toBe("model-v2");
    });

    it("allows setting model back to empty string to re-enable env fallback", () => {
      process.env.GEMINI_MODEL = "env-model";
      setGeminiModel("explicit-model");
      expect(getListenConfig().geminiModel).toBe("explicit-model");

      setGeminiModel("");
      expect(getListenConfig().geminiModel).toBe("env-model");
    });
  });
});
