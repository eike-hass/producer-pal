// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { resolveParams } from "../reference-resolver.ts";

function makeResults(
  entries: Record<string, Record<string, unknown>>,
): Map<string, Record<string, unknown>> {
  return new Map(Object.entries(entries));
}

describe("resolveParams", () => {
  it("resolves a simple field reference", () => {
    const results = makeResults({ track: { trackIndex: 2 } });
    const { resolved, unresolvable } = resolveParams(
      { trackIndex: "${track.trackIndex}" },
      results,
    );

    expect(resolved).toStrictEqual({ trackIndex: "2" });
    expect(unresolvable).toBe(false);
  });

  it("resolves a mid-string reference", () => {
    const results = makeResults({ t: { trackIndex: 3 } });
    const { resolved, unresolvable } = resolveParams(
      { path: "t${t.trackIndex}/d0" },
      results,
    );

    expect(resolved).toStrictEqual({ path: "t3/d0" });
    expect(unresolvable).toBe(false);
  });

  it("resolves a mid-string reference with longer path", () => {
    const results = makeResults({ t: { trackIndex: 0 } });
    const { resolved, unresolvable } = resolveParams(
      { path: "t${t.trackIndex}/d0/rc0" },
      results,
    );

    expect(resolved).toStrictEqual({ path: "t0/d0/rc0" });
    expect(unresolvable).toBe(false);
  });

  it("resolves comma-separated references", () => {
    const results = makeResults({ c1: { id: "clip-1" }, c2: { id: "clip-2" } });
    const { resolved, unresolvable } = resolveParams(
      { ids: "${c1.id},${c2.id}" },
      results,
    );

    expect(resolved).toStrictEqual({ ids: "clip-1,clip-2" });
    expect(unresolvable).toBe(false);
  });

  it("resolves multiple references in a single param value", () => {
    const results = makeResults({
      t1: { trackIndex: 0 },
      t2: { trackIndex: 1 },
    });
    const { resolved, unresolvable } = resolveParams(
      { value: "${t1.trackIndex}/${t2.trackIndex}" },
      results,
    );

    expect(resolved).toStrictEqual({ value: "0/1" });
    expect(unresolvable).toBe(false);
  });

  it("passes through non-string values unchanged", () => {
    const results = makeResults({ t: { trackIndex: 0 } });
    const { resolved, unresolvable } = resolveParams(
      { trackIndex: 0, color: "#FF0000", flag: true },
      results,
    );

    expect(resolved).toStrictEqual({
      trackIndex: 0,
      color: "#FF0000",
      flag: true,
    });
    expect(unresolvable).toBe(false);
  });

  it("returns unresolvable=true for unknown step id", () => {
    const { unresolvable } = resolveParams(
      { trackIndex: "${missing.trackIndex}" },
      makeResults({}),
    );

    expect(unresolvable).toBe(true);
  });

  it("returns unresolvable=true for unknown field", () => {
    const results = makeResults({ t: { trackIndex: 0 } });
    const { unresolvable } = resolveParams(
      { trackIndex: "${t.nonExistentField}" },
      results,
    );

    expect(unresolvable).toBe(true);
  });

  it("returns unresolvable=true if any reference fails in a mixed value", () => {
    const results = makeResults({ good: { id: "g1" } });
    const { unresolvable } = resolveParams(
      { a: "${good.id}", b: "${missing.id}" },
      results,
    );

    expect(unresolvable).toBe(true);
  });

  it("passes through literal ${USD} with no dot as-is", () => {
    const { resolved, unresolvable } = resolveParams(
      { name: "Price ${USD}" },
      makeResults({}),
    );

    expect(resolved).toStrictEqual({ name: "Price ${USD}" });
    expect(unresolvable).toBe(false);
  });

  it("handles empty params object", () => {
    const { resolved, unresolvable } = resolveParams({}, makeResults({}));

    expect(resolved).toStrictEqual({});
    expect(unresolvable).toBe(false);
  });
});
