// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { livePath } from "#src/shared/live-api-path-builders.ts";
import {
  mockNonExistentObjects,
  registerMockObject,
} from "#src/test/mocks/mock-registry.ts";
import { captureStart, parseDurationToBeats } from "./capture.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Encode routing properties the way live-api-extensions.ts expects.
 * @param propName - Property name (e.g. "input_routing_type")
 * @param value - Property value to encode
 * @returns JSON-encoded string with the property wrapped in its name
 */
function routingJson(propName: string, value: unknown): string {
  return JSON.stringify({ [propName]: value });
}

interface LiveSetProperties {
  tempo?: number;
  signature_numerator?: number;
  trackIds?: string[];
  name?: string;
}

function setupLiveSet(
  props: LiveSetProperties = {},
): ReturnType<typeof registerMockObject> {
  const trackIds = props.trackIds ?? ["1"];
  const tracksArray = trackIds.flatMap((id) => ["id", id]);

  return registerMockObject("live_set", {
    path: "live_set",
    type: "Song",
    properties: {
      name: props.name ?? "Test Project",
      tempo: props.tempo ?? 120,
      signature_numerator: props.signature_numerator ?? 4,
      tracks: tracksArray,
    },
  });
}

interface CaptureTrackSetupProps {
  id?: string;
  name?: string;
  inputRoutingTypeName?: string;
  availableInputRoutingTypeNames?: string[];
  outputRoutingTypeName?: string;
  availableOutputRoutingTypeNames?: string[];
}

function setupCaptureTrack(
  trackIndex: number,
  props: CaptureTrackSetupProps = {},
): ReturnType<typeof registerMockObject> {
  const id = props.id ?? `track-${trackIndex}`;
  const inputTypeName = props.inputRoutingTypeName ?? "Resampling";
  const availableInputNames = props.availableInputRoutingTypeNames ?? [
    "Resampling",
    "External In",
  ];
  const outputTypeName = props.outputRoutingTypeName ?? "Sends Only";
  const availableOutputNames = props.availableOutputRoutingTypeNames ?? [
    "Sends Only",
    "Master",
  ];

  const availableInputTypes = availableInputNames.map((name, i) => ({
    display_name: name,
    identifier: i + 1,
  }));
  const currentInputType = { display_name: inputTypeName, identifier: 99 };

  const availableOutputTypes = availableOutputNames.map((name, i) => ({
    display_name: name,
    identifier: i + 10,
  }));
  const currentOutputType = { display_name: outputTypeName, identifier: 98 };

  return registerMockObject(id, {
    path: livePath.track(trackIndex),
    type: "Track",
    properties: {
      name: props.name ?? "_PP Capture",
      has_audio_input: 1,
      input_routing_type: routingJson("input_routing_type", currentInputType),
      available_input_routing_types: routingJson(
        "available_input_routing_types",
        availableInputTypes,
      ),
      output_routing_type: routingJson(
        "output_routing_type",
        currentOutputType,
      ),
      available_output_routing_types: routingJson(
        "available_output_routing_types",
        availableOutputTypes,
      ),
      current_monitoring_state: 1, // Auto by default
    },
  });
}

// ─── captureStart tests ───────────────────────────────────────────────────────

describe("captureStart", () => {
  describe("basic success cases", () => {
    it("returns captureTrackIndex, durationMs, tempo for valid args", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0);

      const result = captureStart({ duration: "4:0" });

      expect(result.captureTrackIndex).toBe(0);
      expect(result.tempo).toBe(120);
      // 4 bars × 4 beats/bar = 16 beats; 16/120 BPM × 60000 = 8000ms
      expect(result.durationMs).toBe(8000);
    });

    it('returns sourceName "master" when source is omitted', () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0);

      const result = captureStart({ duration: "4:0" });

      expect(result.sourceName).toBe("master");
    });

    it("returns projectName from the Live Set", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        name: "My Song",
      });
      setupCaptureTrack(0);

      const result = captureStart({ duration: "4:0" });

      expect(result.projectName).toBe("My Song");
    });

    it('returns sourceName "master" when source is "master"', () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0, {
        availableInputRoutingTypeNames: ["Main", "Resampling"],
      });

      const result = captureStart({ duration: "4:0", source: "master" });

      expect(result.sourceName).toBe("master");
    });

    it("sets monitor to In (0) on the capture track", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0);

      captureStart({ duration: "4:0" });

      expect(track.set).toHaveBeenCalledWith("current_monitoring_state", 0);
    });

    it("uses time signature numerator for bar calculation", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 3 }); // 3/4 time
      setupCaptureTrack(0);

      // "4:0" = 4 bars × 3 beats/bar = 12 beats; 12/120 × 60000 = 6000ms
      const result = captureStart({ duration: "4:0" });

      expect(result.durationMs).toBe(6000);
    });

    it("defaults to 4 bars when no duration provided", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0);

      // Default "4:0" = 16 beats; 16/120 × 60000 = 8000ms
      const result = captureStart({});

      expect(result.durationMs).toBe(8000);
    });

    it("caps durationMs at MAX_DURATION_MS (120s)", () => {
      setupLiveSet({ tempo: 30, signature_numerator: 4 }); // very slow
      setupCaptureTrack(0);

      // "100:0" at 30 BPM = 400 beats = 800s, capped to 120s
      const result = captureStart({ duration: "100:0" });

      expect(result.durationMs).toBe(120_000);
    });
  });

  describe("output routing (Sends Only)", () => {
    it("does not call setProperty for output when already Sends Only", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0, {
        outputRoutingTypeName: "Sends Only",
      });

      captureStart({ duration: "4:0" });

      const setCalls = track.set.mock.calls as unknown[][];
      const outputCalls = setCalls.filter(
        (call) => call[0] === "output_routing_type",
      );

      expect(outputCalls).toHaveLength(0);
    });

    it("sets output to Sends Only when not already set", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0, {
        outputRoutingTypeName: "Master",
        availableOutputRoutingTypeNames: ["Sends Only", "Master"],
      });

      captureStart({ duration: "4:0" });

      const setCalls = track.set.mock.calls as unknown[][];
      const outputCalls = setCalls.filter(
        (call) => call[0] === "output_routing_type",
      );

      expect(outputCalls.length).toBeGreaterThan(0);
    });

    it("throws when Sends Only is not in available output routing types", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0, {
        outputRoutingTypeName: "Master",
        availableOutputRoutingTypeNames: ["Master", "External Out"],
      });

      expect(() => {
        captureStart({ duration: "4:0" });
      }).toThrow("Sends Only");
    });
  });

  describe("input routing (Main/Resampling for master)", () => {
    it("prefers Main over Resampling when both are available", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0, {
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Main", "Resampling", "External In"],
      });

      captureStart({ duration: "4:0" });

      const setCalls = track.set.mock.calls as unknown[][];
      const inputCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(inputCalls.length).toBeGreaterThan(0);
    });

    it("falls back to Resampling when Main is not available", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0, {
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Resampling", "External In"],
      });

      captureStart({ duration: "4:0" });

      const setCalls = track.set.mock.calls as unknown[][];
      const inputCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(inputCalls.length).toBeGreaterThan(0);
    });

    it('sets input routing when source is "master"', () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupCaptureTrack(0, {
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Main", "Resampling", "External In"],
      });

      captureStart({ duration: "4:0", source: "master" });

      const setCalls = track.set.mock.calls as unknown[][];
      const inputCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(inputCalls.length).toBeGreaterThan(0);
    });

    it("throws when neither Main nor Resampling routing is available", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0, {
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["External In"],
      });

      expect(() => {
        captureStart({ duration: "4:0" });
      }).toThrow("no suitable input routing");
    });
  });

  describe("per-track routing", () => {
    it("sets per-track routing when source is a track index", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["t0", "t1"],
      });
      const captureTrack = setupCaptureTrack(0, {
        id: "t0",
        name: "_PP Capture",
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Resampling", "Bass", "External In"],
      });

      // Source track (track 1)
      registerMockObject("t1", {
        path: livePath.track(1),
        type: "Track",
        properties: {
          name: "Bass",
          has_audio_input: 1,
        },
      });

      captureStart({ duration: "4:0", source: 1 });

      const setCalls = captureTrack.set.mock.calls as unknown[][];
      const inputCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(inputCalls.length).toBeGreaterThan(0);
    });

    it("throws when source track does not exist", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupCaptureTrack(0);
      mockNonExistentObjects();

      expect(() => {
        captureStart({ duration: "4:0", source: 99 });
      }).toThrow("source track 99 does not exist");
    });

    it("throws when source track name not found in available input routings", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["t0", "t1"],
      });
      setupCaptureTrack(0, {
        id: "t0",
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Resampling", "External In"],
      });
      registerMockObject("t1", {
        path: livePath.track(1),
        type: "Track",
        properties: {
          name: "Synth Lead",
          has_audio_input: 1,
        },
      });

      expect(() => {
        captureStart({ duration: "4:0", source: 1 });
      }).toThrow('"Synth Lead" not found in available input routings');
    });

    it("returns sourceName equal to the source track name", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["t0", "t1"],
      });
      setupCaptureTrack(0, {
        id: "t0",
        name: "_PP Capture",
        inputRoutingTypeName: "External In",
        availableInputRoutingTypeNames: ["Resampling", "Bass", "External In"],
      });
      registerMockObject("t1", {
        path: livePath.track(1),
        type: "Track",
        properties: { name: "Bass", has_audio_input: 1 },
      });

      const result = captureStart({ duration: "4:0", source: 1 });

      expect(result.sourceName).toBe("Bass");
    });
  });

  describe("find-or-create _PP Capture track", () => {
    it("finds existing _PP Capture track by name", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["t0", "t-capture"],
      });
      setupCaptureTrack(0, { id: "t0", name: "Bass" });
      setupCaptureTrack(1, { id: "t-capture", name: "_PP Capture" });

      const result = captureStart({ duration: "4:0" });

      expect(result.captureTrackIndex).toBe(1);
    });

    it("creates _PP Capture track when none exists", () => {
      const liveSet = registerMockObject("live_set", {
        path: "live_set",
        type: "Song",
        properties: {
          name: "Test Project",
          tempo: 120,
          signature_numerator: 4,
          tracks: ["id", "t0"],
        },
        methods: {
          create_audio_track: () => null,
        },
      });

      setupCaptureTrack(0, { id: "t0", name: "Bass" });
      setupCaptureTrack(1, { id: "t-new", name: "New Audio" });

      liveSet.get.mockImplementation((prop: string) => {
        if (prop === "tracks") return ["id", "t0", "id", "t-new"];
        if (prop === "tempo") return [120];
        if (prop === "signature_numerator") return [4];
        if (prop === "name") return ["Test Project"];

        return [0];
      });

      const result = captureStart({ duration: "4:0" });

      expect(liveSet.call).toHaveBeenCalledWith("create_audio_track", -1);
      expect(result.captureTrackIndex).toBe(1);
    });

    it("sets name to _PP Capture on the new track", () => {
      const liveSet = registerMockObject("live_set", {
        path: "live_set",
        type: "Song",
        properties: {
          name: "Test Project",
          tempo: 120,
          signature_numerator: 4,
          tracks: ["id", "t0"],
        },
        methods: {
          create_audio_track: () => null,
        },
      });

      setupCaptureTrack(0, { id: "t0", name: "Bass" });
      const newTrack = setupCaptureTrack(1, {
        id: "t-new",
        name: "New Audio",
      });

      liveSet.get.mockImplementation((prop: string) => {
        if (prop === "tracks") return ["id", "t0", "id", "t-new"];
        if (prop === "tempo") return [120];
        if (prop === "signature_numerator") return [4];
        if (prop === "name") return ["Test Project"];

        return [0];
      });

      captureStart({ duration: "4:0" });

      expect(newTrack.set).toHaveBeenCalledWith("name", "_PP Capture");
    });
  });
});

// ─── parseDurationToBeats tests ───────────────────────────────────────────────

describe("parseDurationToBeats", () => {
  it('parses "4:0" in 4/4 time to 16 beats', () => {
    expect(parseDurationToBeats("4:0", 4)).toBe(16);
  });

  it('parses "2:2" in 4/4 time to 10 beats', () => {
    expect(parseDurationToBeats("2:2", 4)).toBe(10);
  });

  it('parses "4:0" in 3/4 time to 12 beats', () => {
    expect(parseDurationToBeats("4:0", 3)).toBe(12);
  });

  it("parses plain beat count", () => {
    expect(parseDurationToBeats("8", 4)).toBe(8);
  });

  it('parses "0:0" to 0 beats', () => {
    expect(parseDurationToBeats("0:0", 4)).toBe(0);
  });

  it("falls back to 4 bars for invalid string", () => {
    // "abc" → NaN → beatsPerBar * 4 = 16
    expect(parseDurationToBeats("abc", 4)).toBe(16);
  });

  it("falls back to 4 bars for '0' (falsy)", () => {
    // "0" → Number("0") = 0 (falsy) → beatsPerBar * 4 = 16
    expect(parseDurationToBeats("0", 4)).toBe(16);
  });
});
