// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { VERSION } from "#src/shared/version.ts";
import { toolDefCreateClip } from "#src/tools/clip/create/create-clip.def.ts";
import { toolDefReadClip } from "#src/tools/clip/read/read-clip.def.ts";
import { toolDefUpdateClip } from "#src/tools/clip/update/update-clip.def.ts";
import { toolDefPlayback } from "#src/tools/control/playback.def.ts";
import { toolDefRawLiveApi } from "#src/tools/control/raw-live-api.def.ts";
import { toolDefSelect } from "#src/tools/control/select.def.ts";
import { toolDefCreateDevice } from "#src/tools/device/create/create-device.def.ts";
import { toolDefReadDevice } from "#src/tools/device/read/read-device.def.ts";
import { toolDefUpdateDevice } from "#src/tools/device/update/update-device.def.ts";
import { toolDefReadLiveSet } from "#src/tools/live-set/read-live-set.def.ts";
import { toolDefUpdateLiveSet } from "#src/tools/live-set/update-live-set.def.ts";
import { toolDefDelete } from "#src/tools/operations/delete/delete.def.ts";
import { toolDefDuplicate } from "#src/tools/operations/duplicate/duplicate.def.ts";
import { toolDefCreateScene } from "#src/tools/scene/create-scene.def.ts";
import { toolDefReadScene } from "#src/tools/scene/read-scene.def.ts";
import { toolDefUpdateScene } from "#src/tools/scene/update-scene.def.ts";
import { type ToolDefFunction } from "#src/tools/shared/tool-framework/define-tool.ts";
import { toolDefCreateTrack } from "#src/tools/track/create/create-track.def.ts";
import { toolDefReadTrack } from "#src/tools/track/read/read-track.def.ts";
import { toolDefUpdateTrack } from "#src/tools/track/update/update-track.def.ts";
import { toolDefConnect } from "#src/tools/workflow/connect.def.ts";
import { toolDefContext } from "#src/tools/workflow/context.def.ts";

export type CallLiveApiFunction = (
  tool: string,
  args: object,
) => Promise<object>;

export const STANDARD_TOOL_DEFS: ToolDefFunction[] = [
  toolDefConnect,
  toolDefContext,
  toolDefReadLiveSet,
  toolDefUpdateLiveSet,
  toolDefReadTrack,
  toolDefCreateTrack,
  toolDefUpdateTrack,
  toolDefReadScene,
  toolDefCreateScene,
  toolDefUpdateScene,
  toolDefReadClip,
  toolDefCreateClip,
  toolDefUpdateClip,
  toolDefReadDevice,
  toolDefCreateDevice,
  toolDefUpdateDevice,
  toolDefDelete,
  toolDefDuplicate,
  toolDefSelect,
  toolDefPlayback,
];

/** All standard tool names (frozen). Does not include dev-only tools like ppal-raw-live-api. */
export const TOOL_NAMES: readonly string[] = Object.freeze(
  STANDARD_TOOL_DEFS.map((td) => td.toolName),
);

interface CreateMcpServerOptions {
  smallModelMode?: boolean;
  tools?: string[];
}

/**
 * Create and configure an MCP server instance
 *
 * @param callLiveApi - Function to call Live API
 * @param options - Configuration options
 * @returns Configured MCP server instance
 */
export function createMcpServer(
  callLiveApi: CallLiveApiFunction,
  options: CreateMcpServerOptions = {},
): McpServer {
  const { smallModelMode = false, tools } = options;
  const includedSet = tools ? new Set(tools) : null;

  const server = new McpServer({
    name: "Ableton Live Producer Pal: AI tools for producing music in Ableton Live",
    version: VERSION,
  });

  for (const toolDef of STANDARD_TOOL_DEFS) {
    if (includedSet && !includedSet.has(toolDef.toolName)) continue;
    toolDef(server, callLiveApi, { smallModelMode });
  }

  // Dev-only tool: bypasses the tools whitelist, gated by env var
  if (process.env.ENABLE_RAW_LIVE_API === "true" && !smallModelMode) {
    toolDefRawLiveApi(server, callLiveApi, { smallModelMode });
  }

  // Listen tool: records audio and describes it via Gemini
  if (process.env.ENABLE_LISTEN === "true" && !smallModelMode) {
    registerListenTool(server, callLiveApi);
  }

  return server;
}

/**
 * Register the ppal-listen tool with a custom Node-side handler.
 * Unlike standard tools, this tool orchestrates multiple V8 calls with async waits.
 * @param server - MCP server instance
 * @param callLiveApi - Function to call V8 tools
 */
function registerListenTool(
  server: McpServer,
  callLiveApi: CallLiveApiFunction,
): void {
  server.registerTool(
    "ppal-listen",
    {
      title: "Listen",
      description:
        "Record audio from Ableton and describe it using AI. " +
        "Records master output via resampling, then analyzes with Gemini.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        duration: z
          .string()
          .optional()
          .describe(
            'recording duration in bar:beat format (default: "4:0" = 4 bars)',
          ),
        prompt: z
          .string()
          .optional()
          .describe("what to listen for (default: general audio analysis)"),
        trackIndex: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "0-based index of audio track for resampling (auto-detected/created if omitted)",
          ),
        sceneIndex: z.coerce
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "0-based scene index for recording slot (first empty slot if omitted)",
          ),
        model: z
          .string()
          .optional()
          .describe("Gemini model for analysis (default: gemini-2.5-flash)"),
      }),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const { handleListen } = await import("./listen-handler.ts");

      return await handleListen(callLiveApi, args);
    },
  );
}
