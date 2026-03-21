// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/**
 * Node-side orchestrator for the ppal-run-plan tool.
 * Executes a structured multi-step plan by calling other Producer Pal tools internally.
 */

import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { type CallLiveApiFunction } from "./create-mcp-server.ts";
import {
  buildReport,
  type GroupResult,
  type StepReport,
} from "./helpers/plan-report.ts";
import { planSchema, type Step } from "./helpers/plan-schema.ts";
import { resolveParams } from "./helpers/reference-resolver.ts";

interface McpResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Handle the ppal-run-plan tool call.
 * Parses and validates the plan JSON, executes groups sequentially (steps in parallel),
 * and returns a compact execution report.
 * @param callLiveApi - Function to call V8 tools
 * @param args - Tool arguments (expects args.plan as a JSON string)
 * @returns MCP tool result with execution summary
 */
export async function handleRunPlan(
  callLiveApi: CallLiveApiFunction,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const planStr = args.plan;

  if (typeof planStr !== "string") {
    return errorResult("plan parameter must be a string");
  }

  let rawPlan: unknown;

  try {
    rawPlan = JSON.parse(planStr);
  } catch (e) {
    return errorResult(
      `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const parsed = planSchema.safeParse(rawPlan);

  if (!parsed.success) {
    return errorResult(`Invalid plan: ${parsed.error.message}`);
  }

  const plan = parsed.data;
  const startTime = Date.now();
  const resultsMap = new Map<string, Record<string, unknown>>();
  const groupResults: GroupResult[] = [];
  let aborted = false;

  for (const group of plan.groups) {
    if (aborted) {
      groupResults.push({
        label: group.label,
        steps: group.steps.map((step) => ({
          id: step.id,
          tool: step.tool,
          status: "skipped" as const,
          duration_ms: 0,
        })),
      });
      continue;
    }

    const stepPromises = group.steps.map((step) =>
      executeStep(step, resultsMap, callLiveApi),
    );

    const outcomes = await Promise.allSettled(stepPromises);

    const stepReports: StepReport[] = group.steps.map((step, i) => {
      const outcome = outcomes[i];

      if (outcome == null || outcome.status === "rejected") {
        return {
          id: step.id,
          tool: step.tool,
          status: "failed" as const,
          error: outcome != null ? String(outcome.reason) : "internal error",
          duration_ms: 0,
        };
      }

      return outcome.value;
    });

    for (const report of stepReports) {
      if (
        report.status === "success" &&
        report.id != null &&
        report.result != null
      ) {
        resultsMap.set(report.id, report.result as Record<string, unknown>);
      }
    }

    groupResults.push({ label: group.label, steps: stepReports });

    if (stepReports.some((r) => r.status !== "success")) {
      aborted = true;
    }
  }

  const report = buildReport(groupResults, Date.now() - startTime);

  return { content: [{ type: "text", text: report.summary }] };
}

/**
 * Execute a single step: resolve $-references, call the tool, parse the result.
 * @param step - Plan step to execute
 * @param results - Results map from previously completed steps
 * @param callLiveApi - Function to call V8 tools
 * @returns Step report with outcome, result or error, and duration
 */
async function executeStep(
  step: Step,
  results: Map<string, Record<string, unknown>>,
  callLiveApi: CallLiveApiFunction,
): Promise<StepReport> {
  const stepStart = Date.now();
  const { resolved, unresolvable } = resolveParams(step.params, results);

  if (unresolvable) {
    return {
      id: step.id,
      tool: step.tool,
      status: "skipped",
      error: "Unresolvable $-reference in params",
      duration_ms: Date.now() - stepStart,
    };
  }

  try {
    const response = (await callLiveApi(step.tool, resolved)) as McpResponse;

    if (response.isError) {
      return {
        id: step.id,
        tool: step.tool,
        status: "failed",
        error: response.content[0]?.text ?? "Unknown error",
        duration_ms: Date.now() - stepStart,
      };
    }

    const result = parseV8Result<Record<string, unknown>>(response);

    if (result == null) {
      return {
        id: step.id,
        tool: step.tool,
        status: "failed",
        error: `Failed to parse result: ${response.content[0]?.text ?? ""}`,
        duration_ms: Date.now() - stepStart,
      };
    }

    return {
      id: step.id,
      tool: step.tool,
      status: "success",
      result,
      duration_ms: Date.now() - stepStart,
    };
  } catch (error) {
    return {
      id: step.id,
      tool: step.tool,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - stepStart,
    };
  }
}

/**
 * Parse a V8 tool result from compact JS literal format (unquoted keys).
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
 * Create an MCP error result.
 * @param message - Error message
 * @returns MCP error result
 */
function errorResult(message: string): CallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
