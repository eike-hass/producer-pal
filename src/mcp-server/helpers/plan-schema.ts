// Producer Pal
// Copyright (C) 2026 Adam Murray
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { z } from "zod";

const BLOCKED_TOOLS = new Set(["ppal-run-plan", "ppal-connect"]);

const stepSchema = z.object({
  id: z.string().optional(),
  tool: z
    .string()
    .regex(/^ppal-/, { message: "Tool name must start with ppal-" })
    .refine((t) => !BLOCKED_TOOLS.has(t), {
      message: "Tool is not allowed in plans",
    }),
  params: z.record(z.string(), z.unknown()),
  intent: z.string().optional(),
});

const stepGroupSchema = z.object({
  label: z.string().optional(),
  steps: z.array(stepSchema).min(1, "Group must have at least one step"),
});

export const planSchema = z
  .object({
    intent: z.string(),
    groups: z
      .array(stepGroupSchema)
      .min(1, "Plan must have at least one group"),
  })
  .superRefine((plan, ctx) => {
    const seen = new Set<string>();

    for (const group of plan.groups) {
      for (const step of group.steps) {
        if (step.id == null) continue;

        if (seen.has(step.id)) {
          ctx.addIssue({
            code: "custom",
            message: `Duplicate step id: "${step.id}"`,
          });

          return;
        }

        seen.add(step.id);
      }
    }
  });

export type Plan = z.infer<typeof planSchema>;
export type StepGroup = z.infer<typeof stepGroupSchema>;
export type Step = z.infer<typeof stepSchema>;
