// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { type CallLiveApiFunction } from "./create-mcp-server.ts";

/**
 * Register the ppal-run-plan tool with a custom Node-side handler.
 * Executes multi-step production plans by calling other Producer Pal tools internally.
 *
 * @param server - MCP server instance
 * @param callLiveApi - Function to call V8 tools
 */
export function registerRunPlanTool(
  server: McpServer,
  callLiveApi: CallLiveApiFunction,
): void {
  server.registerTool(
    "ppal-run-plan",
    {
      title: "Run Plan",
      description:
        "Execute a multi-step production plan. Pass a JSON plan string. " +
        "See Producer Pal Skills for plan format and ${} reference syntax.",
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        plan: z
          .string()
          .describe("JSON-encoded plan (see Producer Pal Skills for schema)"),
      }),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const { handleRunPlan } = await import("./run-plan-handler.ts");

      return await handleRunPlan(callLiveApi, args);
    },
  );
}
