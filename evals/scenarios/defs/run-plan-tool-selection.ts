// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Scenario: LLM uses ppal-run-plan for multi-step tasks instead of individual tool calls.
 *
 * Requires the ppal-run-plan tool to be enabled (ENABLE_RUN_PLAN=true build).
 */

import { TOOL_NAMES } from "#src/mcp-server/create-mcp-server.ts";
import { type EvalScenario } from "../types.ts";

export const runPlanToolSelection: EvalScenario = {
  id: "run-plan-tool-selection",
  description:
    "LLM uses ppal-run-plan for multi-step tasks instead of individual tool calls",
  liveSet: "basic-midi-4-track",

  // Requires ppal-run-plan to be in the tool list (ENABLE_RUN_PLAN=true build)
  config: { tools: [...TOOL_NAMES, "ppal-run-plan"] },

  messages: [
    "Connect to Ableton Live",
    "Create a MIDI track called 'Synth', add Wavetable to it, and create a 2-bar session clip in slot 0 with a C major arpeggio",
  ],

  assertions: [
    // Turn 0: connection
    { type: "tool_called", tool: "ppal-connect", turn: 0, score: 3 },

    // Turn 1: must use ppal-run-plan (the 3-step task is exactly the trigger case from the skills docs)
    { type: "tool_called", tool: "ppal-run-plan", turn: 1, score: 10 },

    // Turn 1: must NOT call individual tools directly — they belong inside the plan
    {
      type: "tool_called",
      tool: "ppal-create-track",
      turn: 1,
      count: 0,
      score: 5,
    },
    {
      type: "tool_called",
      tool: "ppal-create-device",
      turn: 1,
      count: 0,
      score: 5,
    },
    {
      type: "tool_called",
      tool: "ppal-create-clip",
      turn: 1,
      count: 0,
      score: 5,
    },

    // State: the track named "Synth" actually exists
    {
      type: "state",
      tool: "ppal-read-live-set",
      args: { include: ["tracks"] },
      expect: (result) =>
        (result as { tracks?: { name: string }[] }).tracks?.some((t) =>
          /synth/i.test(t.name),
        ) ?? false,
      score: 5,
    },

    // Response should confirm all steps completed
    { type: "response_contains", pattern: /complet|creat|done/i, turn: 1, score: 2 },

    {
      type: "llm_judge",
      prompt: `Evaluate if the assistant:
1. Used ppal-run-plan (not individual tool calls) to batch all 3 operations
2. The plan included track creation, Wavetable device load, and clip creation as steps
3. The response confirmed all steps completed successfully`,
      score: 10,
    },
  ],
};
