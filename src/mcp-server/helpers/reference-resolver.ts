// Producer Pal
// Copyright (C) 2026 Adam Murray
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

/** Matches ${id.field} patterns within strings. */
const REFERENCE_PATTERN = /\${([A-Za-z]\w*)\.([A-Za-z]\w*)}/g;

/**
 * Resolve $-references in step params using results from previous steps.
 * Non-string values pass through unchanged.
 * @param params - Step params, potentially containing ${id.field} string references
 * @param results - Results map from previously executed steps
 * @returns Resolved params and whether any reference was unresolvable
 */
export function resolveParams(
  params: Record<string, unknown>,
  results: Map<string, Record<string, unknown>>,
): { resolved: Record<string, unknown>; unresolvable: boolean } {
  const resolved: Record<string, unknown> = {};
  let unresolvable = false;

  for (const [key, value] of Object.entries(params)) {
    if (typeof value !== "string") {
      resolved[key] = value;
      continue;
    }

    const result = resolveString(value, results);

    resolved[key] = result.resolved;
    if (result.unresolvable) unresolvable = true;
  }

  return { resolved, unresolvable };
}

/**
 * Resolve all $-references in a single string value.
 * Unrecognised patterns (no dot, invalid identifiers) are left unchanged.
 * @param value - String value potentially containing ${id.field} references
 * @param results - Results map from previously executed steps
 * @returns Resolved string and whether any reference was unresolvable
 */
function resolveString(
  value: string,
  results: Map<string, Record<string, unknown>>,
): { resolved: string; unresolvable: boolean } {
  let unresolvable = false;

  const resolved = value.replaceAll(
    REFERENCE_PATTERN,
    (match, id: string, field: string) => {
      const stepResult = results.get(id);

      if (stepResult == null) {
        unresolvable = true;

        return match;
      }

      const fieldValue = stepResult[field];

      if (fieldValue == null) {
        unresolvable = true;

        return match;
      }

      return String(fieldValue);
    },
  );

  return { resolved, unresolvable };
}
