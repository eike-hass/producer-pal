// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Shared configuration for the listen tool.
 * Set by Max.addHandler in create-express-app.ts, read by listen-handler.ts.
 */

export interface ListenConfig {
  geminiKey: string;
  geminiModel: string;
}

const listenConfig: ListenConfig = {
  geminiKey: "",
  geminiModel: "",
};

/**
 * Get the current listen config.
 * Falls back to process.env if not set via Max device UI.
 * @returns Current listen configuration
 */
export function getListenConfig(): ListenConfig {
  return {
    geminiKey: listenConfig.geminiKey || (process.env.GEMINI_KEY ?? ""),
    geminiModel: listenConfig.geminiModel || (process.env.GEMINI_MODEL ?? ""),
  };
}

/**
 * Set the Gemini API key.
 * @param key - Gemini API key
 */
export function setGeminiKey(key: string): void {
  listenConfig.geminiKey = key;
}

/**
 * Set the Gemini model.
 * @param model - Gemini model name
 */
export function setGeminiModel(model: string): void {
  listenConfig.geminiModel = model;
}
