// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { type CallLiveApiFunction } from "#src/mcp-server/create-mcp-server.ts";
import { handleRunPlan } from "#src/mcp-server/run-plan-handler.ts";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockBehavior =
  | { type: "success"; data: Record<string, unknown> }
  | { type: "error"; message: string }
  | { type: "throw"; message: string }
  | { type: "unparseable" };

const DEFAULTS: Record<string, Record<string, unknown>> = {
  "ppal-create-track": { id: "t1", trackIndex: 0 },
  "ppal-create-clip": { id: "c1" },
  "ppal-create-device": { id: "d1", deviceIndex: 0 },
  "ppal-create-scene": { id: "s1", sceneIndex: 0 },
  "ppal-update-track": { id: "t1" },
  "ppal-update-clip": { id: "c1" },
  "ppal-update-device": { id: "d1" },
  "ppal-update-live-set": {},
  "ppal-delete": { id: "del1", deleted: true },
  "ppal-select": {},
  "ppal-playback": {},
};

function makeMock(
  overrides: Record<string, MockBehavior> = {},
): CallLiveApiFunction {
  return async (tool) => {
    const override = overrides[tool];

    if (override) {
      if (override.type === "success") {
        return {
          content: [{ type: "text", text: JSON.stringify(override.data) }],
        };
      }

      if (override.type === "error") {
        return {
          content: [{ type: "text", text: override.message }],
          isError: true,
        };
      }

      if (override.type === "throw") {
        throw new Error(override.message);
      }

      // type === "unparseable"
      return { content: [{ type: "text", text: "not valid {{{{ json" }] };
    }

    const data = DEFAULTS[tool] ?? {};

    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  };
}

function plan(obj: unknown): string {
  return JSON.stringify(obj);
}

function getResult(result: Awaited<ReturnType<typeof handleRunPlan>>): string {
  return (result.content[0] as { text: string }).text;
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe("handleRunPlan - happy path", () => {
  it("executes a single group with a single step", async () => {
    const mock = makeMock();
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "create a track",
        groups: [
          {
            steps: [
              {
                tool: "ppal-create-track",
                params: { name: "Bass", type: "midi" },
              },
            ],
          },
        ],
      }),
    });

    expect(result.isError).toBeFalsy();
    expect(getResult(result)).toContain("COMPLETED (1/1 steps");
  });

  it("executes multi-group plan with $-references", async () => {
    const mock = makeMock();
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "drums",
        groups: [
          {
            steps: [
              {
                id: "t",
                tool: "ppal-create-track",
                params: { name: "Drums", type: "midi" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-create-device",
                params: { deviceName: "Drum Rack", path: "t${t.trackIndex}" },
              },
              {
                id: "c",
                tool: "ppal-create-clip",
                params: { trackIndex: "${t.trackIndex}", length: "4:0" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-update-clip",
                params: { ids: "${c.id}", transforms: "C1: velocity = 100" },
              },
            ],
          },
        ],
      }),
    });

    expect(result.isError).toBeFalsy();
    expect(getResult(result)).toContain("COMPLETED (4/4 steps");
  });

  it("dispatches all steps in a group and all succeed", async () => {
    const mock = vi.fn(makeMock());

    await handleRunPlan(mock, {
      plan: plan({
        intent: "three updates",
        groups: [
          {
            steps: [
              {
                id: "t",
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-update-track",
                params: { trackIndex: "${t.trackIndex}", name: "X" },
              },
              {
                tool: "ppal-update-track",
                params: { trackIndex: "${t.trackIndex}", name: "Y" },
              },
              {
                tool: "ppal-update-track",
                params: { trackIndex: "${t.trackIndex}", name: "Z" },
              },
            ],
          },
        ],
      }),
    });
    expect(mock).toHaveBeenCalledTimes(4);
    const calls = mock.mock.calls.map((c) => c[0]);

    expect(calls.filter((t) => t === "ppal-update-track")).toHaveLength(3);
  });

  it("executes steps without ids (no reference resolution needed)", async () => {
    const mock = makeMock();
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "two updates",
        groups: [
          {
            steps: [
              { tool: "ppal-update-live-set", params: { tempo: 140 } },
              { tool: "ppal-update-live-set", params: { metronome: true } },
            ],
          },
        ],
      }),
    });

    expect(result.isError).toBeFalsy();
    expect(getResult(result)).toContain("COMPLETED (2/2 steps");
  });

  it("resolves mid-string references in device path", async () => {
    const called = vi.fn(makeMock());

    await handleRunPlan(called, {
      plan: plan({
        intent: "add device",
        groups: [
          {
            steps: [
              {
                id: "t",
                tool: "ppal-create-track",
                params: { name: "Synth", type: "midi" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-create-device",
                params: { deviceName: "Wavetable", path: "t${t.trackIndex}" },
              },
            ],
          },
        ],
      }),
    });
    const deviceCall = called.mock.calls.find(
      (c) => c[0] === "ppal-create-device",
    );

    expect(deviceCall?.[1]).toMatchObject({ path: "t0" });
  });

  it("resolves comma-separated references", async () => {
    const mock = makeMock({
      "ppal-create-clip": { type: "success", data: { id: "clip-1" } },
    });
    const called = vi.fn(mock);

    await handleRunPlan(called, {
      plan: plan({
        intent: "bulk update",
        groups: [
          {
            steps: [
              {
                id: "c1",
                tool: "ppal-create-clip",
                params: { trackIndex: 0, sceneIndex: 0 },
              },
              {
                id: "c2",
                tool: "ppal-create-clip",
                params: { trackIndex: 0, sceneIndex: 1 },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-update-clip",
                params: { ids: "${c1.id},${c2.id}", name: "Updated" },
              },
            ],
          },
        ],
      }),
    });
    const updateCall = called.mock.calls.find(
      (c) => c[0] === "ppal-update-clip",
    );

    expect(updateCall?.[1]).toMatchObject({ ids: "clip-1,clip-1" });
  });
});

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

describe("handleRunPlan - validation errors", () => {
  it("rejects non-string plan parameter", async () => {
    const result = await handleRunPlan(makeMock(), { plan: 42 });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("must be a string");
  });

  it("rejects invalid JSON", async () => {
    const result = await handleRunPlan(makeMock(), { plan: "not json at all" });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid JSON");
  });

  it("rejects plan missing required intent field", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        groups: [{ steps: [{ tool: "ppal-create-track", params: {} }] }],
      }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });

  it("rejects plan with empty groups array", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({ intent: "nothing", groups: [] }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });

  it("rejects group with empty steps array", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({ intent: "empty group", groups: [{ steps: [] }] }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });

  it("rejects plan with duplicate step ids", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        intent: "dup ids",
        groups: [
          {
            steps: [
              {
                id: "x",
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
              {
                id: "x",
                tool: "ppal-create-track",
                params: { name: "B", type: "midi" },
              },
            ],
          },
        ],
      }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Duplicate step id");
  });

  it("rejects ppal-run-plan as a step tool (no recursion)", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        intent: "recursive",
        groups: [
          { steps: [{ tool: "ppal-run-plan", params: { plan: "{}" } }] },
        ],
      }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });

  it("rejects ppal-connect as a step tool", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        intent: "connect",
        groups: [{ steps: [{ tool: "ppal-connect", params: {} }] }],
      }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });

  it("rejects non-ppal tool names", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        intent: "escape",
        groups: [
          { steps: [{ tool: "shell-exec", params: { cmd: "whoami" } }] },
        ],
      }),
    });

    expect(result.isError).toBe(true);
    expect(getResult(result)).toContain("Invalid plan");
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe("handleRunPlan - failure handling", () => {
  it("skips all subsequent groups when first group fails", async () => {
    const mock = makeMock({
      "ppal-create-track": { type: "error", message: "invalid track type" },
    });
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "track then clip",
        groups: [
          {
            steps: [
              {
                id: "t",
                tool: "ppal-create-track",
                params: { name: "X", type: "invalid" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-create-clip",
                params: { trackIndex: "${t.trackIndex}" },
              },
            ],
          },
        ],
      }),
    });

    expect(result.isError).toBeFalsy();
    const text = getResult(result);

    expect(text).toContain("FAILED");
    expect(text).toContain("invalid track type");
    expect(text).toContain("[skipped]");
  });

  it("reports partial when earlier groups succeed and later group fails", async () => {
    let clipCallCount = 0;
    const mock = makeMock({
      "ppal-create-clip": {
        type: "error",
        message: "invalid length",
      },
    });
    const spy = vi.fn(async (tool: string, args: object) => {
      if (tool === "ppal-create-clip") clipCallCount++;

      return await mock(tool, args);
    });

    const result = await handleRunPlan(spy, {
      plan: plan({
        intent: "three groups",
        groups: [
          {
            steps: [
              {
                id: "t",
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
            ],
          },
          {
            steps: [
              {
                id: "c",
                tool: "ppal-create-clip",
                params: { trackIndex: "${t.trackIndex}", length: "999:0" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-update-clip",
                params: { ids: "${c.id}", name: "Done" },
              },
            ],
          },
        ],
      }),
    });

    const text = getResult(result);

    expect(text).toContain("PARTIAL");
    expect(text).toContain("[skipped]");
    expect(clipCallCount).toBe(1);
  });

  it("runs all parallel steps to completion even when one fails", async () => {
    const called: string[] = [];
    const mock = vi.fn(async (tool: string, args: object) => {
      called.push(tool);

      return await makeMock({
        "ppal-create-scene": { type: "error", message: "not found" },
      })(tool, args);
    });

    await handleRunPlan(mock, {
      plan: plan({
        intent: "parallel with one failure",
        groups: [
          {
            steps: [
              { tool: "ppal-update-live-set", params: { tempo: 140 } },
              { tool: "ppal-create-scene", params: { name: "X" } },
            ],
          },
        ],
      }),
    });

    expect(called).toContain("ppal-update-live-set");
    expect(called).toContain("ppal-create-scene");
  });

  it("skips step with unresolvable reference", async () => {
    const result = await handleRunPlan(makeMock(), {
      plan: plan({
        intent: "broken ref",
        groups: [
          {
            steps: [
              {
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
            ],
          },
          {
            steps: [
              {
                tool: "ppal-update-track",
                params: { trackIndex: "${missing.trackIndex}" },
              },
            ],
          },
        ],
      }),
    });
    const text = getResult(result);

    expect(text).toContain("PARTIAL");
  });

  it("marks step as failed when V8 result cannot be parsed", async () => {
    const mock = makeMock({ "ppal-create-track": { type: "unparseable" } });
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "bad result",
        groups: [
          {
            steps: [
              {
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
            ],
          },
        ],
      }),
    });
    const text = getResult(result);

    expect(text).toContain("FAILED");
    expect(text).toContain("Failed to parse result");
  });

  it("marks step as failed when callLiveApi throws", async () => {
    const mock = makeMock({
      "ppal-create-track": { type: "throw", message: "connection lost" },
    });
    const result = await handleRunPlan(mock, {
      plan: plan({
        intent: "throw test",
        groups: [
          {
            steps: [
              {
                tool: "ppal-create-track",
                params: { name: "A", type: "midi" },
              },
            ],
          },
        ],
      }),
    });
    const text = getResult(result);

    expect(text).toContain("connection lost");
  });
});
