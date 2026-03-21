// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { buildReport, type GroupResult } from "../plan-report.ts";

const success = (tool: string, id?: string): GroupResult["steps"][number] => ({
  id,
  tool,
  status: "success",
  result: {},
  duration_ms: 10,
});

const failed = (
  tool: string,
  error: string,
  id?: string,
): GroupResult["steps"][number] => ({
  id,
  tool,
  status: "failed",
  error,
  duration_ms: 10,
});

const skipped = (tool: string): GroupResult["steps"][number] => ({
  tool,
  status: "skipped",
  duration_ms: 0,
});

describe("buildReport", () => {
  it("reports completed with correct summary for all-success plan", () => {
    const groups: GroupResult[] = [
      {
        label: "Create drum track",
        steps: [success("ppal-create-track", "track")],
      },
      {
        label: "Add device and clip",
        steps: [
          success("ppal-create-device"),
          success("ppal-create-clip", "clip"),
        ],
      },
      {
        label: "Humanize",
        steps: [success("ppal-update-clip"), success("ppal-update-clip")],
      },
    ];
    const report = buildReport(groups, 1200);

    expect(report.status).toBe("completed");
    expect(report.summary).toBe(
      "COMPLETED (5/5 steps, 1.2s)\n" +
        'Group "Create drum track": track ✓\n' +
        'Group "Add device and clip": create-device ✓, clip ✓\n' +
        'Group "Humanize": update-clip ✓, update-clip ✓',
    );
  });

  it("reports partial with correct summary for mid-plan failure", () => {
    const groups: GroupResult[] = [
      { label: "Setup", steps: [success("ppal-create-track", "track")] },
      {
        label: "Content",
        steps: [
          success("ppal-create-clip"),
          failed("ppal-create-device", "NonExistentPlugin not found"),
        ],
      },
      { label: "Polish", steps: [skipped("ppal-update-clip")] },
    ];
    const report = buildReport(groups, 800);

    expect(report.status).toBe("partial");
    expect(report.summary).toBe(
      "PARTIAL (2/4 steps, 0.8s)\n" +
        'Group "Setup": track ✓\n' +
        'Group "Content": create-clip ✓, create-device ✗ "NonExistentPlugin not found"\n' +
        'Group "Polish": [skipped]',
    );
  });

  it("reports failed with correct summary for first-step failure", () => {
    const groups: GroupResult[] = [
      {
        label: "Setup",
        steps: [failed("ppal-create-track", "invalid track type", "track")],
      },
    ];
    const report = buildReport(groups, 100);

    expect(report.status).toBe("failed");
    expect(report.summary).toBe(
      "FAILED (0/1 steps, 0.1s)\n" +
        'Group "Setup": track ✗ "invalid track type"',
    );
  });

  it("uses 1-based index for unlabeled groups", () => {
    const groups: GroupResult[] = [
      { steps: [success("ppal-create-track")] },
      { steps: [success("ppal-update-track")] },
    ];
    const report = buildReport(groups, 500);

    expect(report.summary).toBe(
      "COMPLETED (2/2 steps, 0.5s)\n" +
        "Group 1: create-track ✓\n" +
        "Group 2: update-track ✓",
    );
  });

  it("shows [skipped] when all steps in a group are skipped", () => {
    const groups: GroupResult[] = [
      { label: "A", steps: [success("ppal-create-track")] },
      {
        label: "B",
        steps: [skipped("ppal-update-track"), skipped("ppal-update-clip")],
      },
    ];
    const report = buildReport(groups, 100);

    expect(report.summary).toContain('Group "B": [skipped]');
  });

  it("shows individual tokens when only some steps in a group are skipped", () => {
    const groups: GroupResult[] = [
      {
        label: "Mixed",
        steps: [success("ppal-create-device"), skipped("ppal-update-clip")],
      },
    ];
    const report = buildReport(groups, 100);

    expect(report.summary).toContain("create-device ✓, update-clip -");
  });

  it("includes all steps flat in report.steps", () => {
    const groups: GroupResult[] = [
      {
        steps: [
          success("ppal-create-track"),
          failed("ppal-create-clip", "oops"),
        ],
      },
    ];
    const report = buildReport(groups, 100);

    expect(report.steps).toHaveLength(2);
    expect(report.duration_ms).toBe(100);
  });

  it("failed step without error omits error snippet", () => {
    const groups: GroupResult[] = [
      {
        steps: [
          { tool: "ppal-create-track", status: "failed", duration_ms: 10 },
        ],
      },
    ];
    const report = buildReport(groups, 100);

    expect(report.summary).toContain("create-track ✗");
    expect(report.summary).not.toContain('"');
  });
});
