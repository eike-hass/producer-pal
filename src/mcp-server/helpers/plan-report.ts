// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

export interface StepReport {
  id?: string;
  tool: string;
  status: "success" | "failed" | "skipped";
  result?: unknown;
  error?: string;
  duration_ms: number;
}

export interface GroupResult {
  label?: string;
  steps: StepReport[];
}

export interface ExecutionReport {
  status: "completed" | "partial" | "failed";
  duration_ms: number;
  steps: StepReport[];
  summary: string;
}

/**
 * Build an execution report from collected group results.
 * @param groups - Results for each group, including skipped groups
 * @param totalDurationMs - Wall-clock duration of the entire plan execution
 * @returns Execution report with status, steps, and compact summary
 */
export function buildReport(
  groups: GroupResult[],
  totalDurationMs: number,
): ExecutionReport {
  const allSteps = groups.flatMap((g) => g.steps);
  const succeeded = allSteps.filter((s) => s.status === "success").length;
  const total = allSteps.length;

  const status: ExecutionReport["status"] =
    succeeded === total ? "completed" : succeeded > 0 ? "partial" : "failed";

  const summary = buildSummary(
    groups,
    succeeded,
    total,
    totalDurationMs,
    status,
  );

  return { status, duration_ms: totalDurationMs, steps: allSteps, summary };
}

/**
 * Build the compact summary string for the planner's context window.
 * @param groups - Results for each group
 * @param succeeded - Number of successful steps
 * @param total - Total number of steps
 * @param totalDurationMs - Wall-clock duration in ms
 * @param status - Overall execution status
 * @returns Multi-line summary string
 */
function buildSummary(
  groups: GroupResult[],
  succeeded: number,
  total: number,
  totalDurationMs: number,
  status: ExecutionReport["status"],
): string {
  const seconds = (totalDurationMs / 1000).toFixed(1);
  const statusLine = `${status.toUpperCase()} (${succeeded}/${total} steps, ${seconds}s)`;

  const groupLines = groups.map((group, index) => {
    const label = group.label != null ? `"${group.label}"` : String(index + 1);
    const prefix = `Group ${label}`;

    if (group.steps.every((s) => s.status === "skipped")) {
      return `${prefix}: [skipped]`;
    }

    const stepTokens = group.steps.map(stepSummaryToken).join(", ");

    return `${prefix}: ${stepTokens}`;
  });

  return [statusLine, ...groupLines].join("\n");
}

/**
 * Produce the summary token for a single step (e.g. "track ✓" or "create-device ✗ "error"").
 * Uses step id if present, otherwise strips the "ppal-" prefix from the tool name.
 * @param step - Step report to summarise
 * @returns Compact token string for the summary line
 */
function stepSummaryToken(step: StepReport): string {
  const label = step.id ?? step.tool.replace(/^ppal-/, "");

  if (step.status === "success") return `${label} ✓`;
  if (step.status === "skipped") return `${label} -`;

  const errorSnippet = step.error != null ? ` "${step.error}"` : "";

  return `${label} ✗${errorSnippet}`;
}
