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
import { listenStart, listenStop } from "./listen.ts";

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface LiveSetProperties {
  tempo?: number;
  signature_numerator?: number;
  trackIds?: string[];
  sceneIds?: string[];
}

/**
 * Encode routing properties the way live-api-extensions.ts expects.
 * get(prop) returns [JSON.stringify({ [prop]: value })]
 * @param propName - Property name (e.g. "input_routing_type")
 * @param value - Property value to encode
 * @returns JSON-encoded string with the property wrapped in its name
 */
function routingJson(propName: string, value: unknown): string {
  return JSON.stringify({ [propName]: value });
}

function setupLiveSet(
  props: LiveSetProperties = {},
): ReturnType<typeof registerMockObject> {
  const trackIds = props.trackIds ?? ["1"];
  const sceneIds = props.sceneIds ?? ["100"];

  // Build the tracks/scenes arrays in the "id", "<id>" interleaved format
  const tracksArray = trackIds.flatMap((id) => ["id", id]);
  const scenesArray = sceneIds.flatMap((id) => ["id", id]);

  return registerMockObject("live_set", {
    path: "live_set",
    type: "Song",
    properties: {
      tempo: props.tempo ?? 120,
      signature_numerator: props.signature_numerator ?? 4,
      tracks: tracksArray,
      scenes: scenesArray,
    },
  });
}

interface AudioTrackSetupProps {
  id?: string;
  hasAudioInput?: number;
  inputRoutingTypeName?: string;
  availableRoutingTypeNames?: string[];
}

function setupAudioTrack(
  trackIndex: number,
  props: AudioTrackSetupProps = {},
): ReturnType<typeof registerMockObject> {
  const id = props.id ?? `track-${trackIndex}`;
  const hasAudioInput = props.hasAudioInput ?? 1;
  const inputRoutingTypeName = props.inputRoutingTypeName ?? "Resampling";
  const availableNames = props.availableRoutingTypeNames ?? [
    "Resampling",
    "External In",
  ];

  const availableTypes = availableNames.map((name, i) => ({
    display_name: name,
    identifier: i + 1,
  }));
  const currentType = { display_name: inputRoutingTypeName, identifier: 99 };

  return registerMockObject(id, {
    path: livePath.track(trackIndex),
    type: "Track",
    properties: {
      has_audio_input: hasAudioInput,
      // Routing props: getProperty() calls get(prop)[0] → JSON.parse → result[prop]
      input_routing_type: routingJson("input_routing_type", currentType),
      available_input_routing_types: routingJson(
        "available_input_routing_types",
        availableTypes,
      ),
    },
  });
}

interface ClipSlotSetupProps {
  hasClip?: number;
}

function setupClipSlot(
  trackIndex: number,
  sceneIndex: number,
  props: ClipSlotSetupProps = {},
): ReturnType<typeof registerMockObject> {
  return registerMockObject(`slot-${trackIndex}-${sceneIndex}`, {
    path: livePath.track(trackIndex).clipSlot(sceneIndex),
    type: "ClipSlot",
    properties: {
      has_clip: props.hasClip ?? 0,
    },
  });
}

interface ClipSetupProps {
  filePath?: string;
  id?: string;
}

function setupClip(
  trackIndex: number,
  sceneIndex: number,
  props: ClipSetupProps = {},
): ReturnType<typeof registerMockObject> {
  return registerMockObject(props.id ?? `clip-${trackIndex}-${sceneIndex}`, {
    path: livePath.track(trackIndex).clipSlot(sceneIndex).clip(),
    type: "Clip",
    properties: {
      file_path: props.filePath ?? "/tmp/recording.wav",
    },
  });
}

// ─── listenStart tests ────────────────────────────────────────────────────────

describe("listenStart", () => {
  describe("basic success cases", () => {
    it("returns trackIndex, sceneIndex, durationMs, tempo for valid args", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "4:0",
      });

      expect(result.trackIndex).toBe(0);
      expect(result.sceneIndex).toBe(0);
      expect(result.tempo).toBe(120);
      // 4 bars × 4 beats/bar = 16 beats; 16/120 BPM × 60000 = 8000ms
      expect(result.durationMs).toBe(8000);
    });

    it("calculates durationMs correctly from bar:beat format", () => {
      setupLiveSet({ tempo: 100, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "2:2" = 2 bars × 4 + 2 beats = 10 beats; 10/100 × 60000 = 6000ms
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "2:2",
      });

      expect(result.durationMs).toBe(6000);
    });

    it("calculates durationMs correctly from plain beat count", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "8" = 8 beats; 8/120 × 60000 = 4000ms
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "8",
      });

      expect(result.durationMs).toBe(4000);
    });

    it("uses 4 bars as default for invalid duration string", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "abc" → Number("abc") = NaN → falls back to beatsPerBar * 4 = 16 beats
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "abc",
      });

      // 16/120 × 60000 = 8000ms
      expect(result.durationMs).toBe(8000);
    });

    it("fires the clip slot to start recording", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      const slot = setupClipSlot(0, 0, { hasClip: 0 });

      listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });

      expect(slot.call).toHaveBeenCalledWith("fire");
    });

    it("arms the track before recording", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupAudioTrack(0);

      setupClipSlot(0, 0, { hasClip: 0 });

      listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });

      expect(track.set).toHaveBeenCalledWith("arm", 1);
    });

    it("uses time signature numerator for bar calculation", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 3 }); // 3/4 time
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "4:0" = 4 bars × 3 beats/bar = 12 beats; 12/120 × 60000 = 6000ms
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "4:0",
      });

      expect(result.durationMs).toBe(6000);
    });
  });

  describe("track validation", () => {
    it("throws when track does not exist", () => {
      setupLiveSet();
      // Make unregistered objects non-existent
      mockNonExistentObjects();

      expect(() => {
        listenStart({ trackIndex: 99, sceneIndex: 0, duration: "4:0" });
      }).toThrow("track 99 does not exist");
    });

    it("throws when track is not an audio track", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0, { hasAudioInput: 0 }); // MIDI track (no audio input)

      expect(() => {
        listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });
      }).toThrow("track 0 is not an audio track");
    });
  });

  describe("clip slot validation", () => {
    it("throws when clip slot does not exist", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      mockNonExistentObjects();

      expect(() => {
        listenStart({ trackIndex: 0, sceneIndex: 99, duration: "4:0" });
      }).toThrow("clip slot 0/99 does not exist");
    });

    it("throws when clip slot already has a clip", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 1 }); // slot already occupied

      expect(() => {
        listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });
      }).toThrow("clip slot 0/0 already has a clip");
    });
  });

  describe("resampling input setup", () => {
    it("calls setProperty when routing is not Resampling", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupAudioTrack(0, {
        inputRoutingTypeName: "External In",
        availableRoutingTypeNames: ["Resampling", "External In"],
      });

      setupClipSlot(0, 0, { hasClip: 0 });

      listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });

      // setProperty calls track.set() with JSON-encoded routing data
      const setCalls = track.set.mock.calls as unknown[][];
      const routingCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(routingCalls.length).toBeGreaterThan(0);
    });

    it("does not call set for routing when already set to Resampling", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      const track = setupAudioTrack(0, {
        inputRoutingTypeName: "Resampling",
      });

      setupClipSlot(0, 0, { hasClip: 0 });

      listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });

      const setCalls = track.set.mock.calls as unknown[][];
      const routingCalls = setCalls.filter(
        (call) => call[0] === "input_routing_type",
      );

      expect(routingCalls).toHaveLength(0);
    });

    it("throws when Resampling routing is not available on track", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0, {
        inputRoutingTypeName: "External In",
        availableRoutingTypeNames: ["External In"],
        // No Resampling option
      });
      setupClipSlot(0, 0, { hasClip: 0 });

      expect(() => {
        listenStart({ trackIndex: 0, sceneIndex: 0, duration: "4:0" });
      }).toThrow("Resampling input routing not available");
    });
  });

  describe("auto-finding track and scene", () => {
    it("auto-detects existing resampling track when trackIndex not provided", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["1"],
        sceneIds: ["100"],
      });
      setupAudioTrack(0, {
        id: "1",
        inputRoutingTypeName: "Resampling",
      });
      setupClipSlot(0, 0, { hasClip: 0 });

      const result = listenStart({ duration: "4:0" });

      expect(result.trackIndex).toBe(0);
    });

    it("skips non-audio tracks when auto-detecting resampling track", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["1", "2"],
        sceneIds: ["100"],
      });
      // Track 0 is a MIDI track (no audio input)
      setupAudioTrack(0, {
        id: "1",
        hasAudioInput: 0,
      });
      // Track 1 is audio with Resampling
      setupAudioTrack(1, {
        id: "2",
        inputRoutingTypeName: "Resampling",
      });
      setupClipSlot(1, 0, { hasClip: 0 });

      const result = listenStart({ duration: "4:0" });

      expect(result.trackIndex).toBe(1);
    });

    it("creates a new audio track named 'Resample' when none exists", () => {
      // Live set with one non-resampling audio track
      const liveSet = registerMockObject("live_set", {
        path: "live_set",
        type: "Song",
        properties: {
          tempo: 120,
          signature_numerator: 4,
          tracks: ["id", "t1"],
          scenes: ["id", "100"],
        },
        methods: {
          create_audio_track: () => null,
        },
      });

      setupAudioTrack(0, { id: "t1", inputRoutingTypeName: "External In" });
      const newTrack = setupAudioTrack(1, {
        id: "t-new",
        inputRoutingTypeName: "External In",
        availableRoutingTypeNames: ["Resampling"],
      });

      setupClipSlot(1, 0, { hasClip: 0 });

      liveSet.get.mockImplementation((prop: string) => {
        if (prop === "tracks") return ["id", "t1", "id", "t-new"];
        if (prop === "tempo") return [120];
        if (prop === "signature_numerator") return [4];
        if (prop === "scenes") return ["id", "100"];

        return [0];
      });

      const result = listenStart({ duration: "4:0" });

      expect(liveSet.call).toHaveBeenCalledWith("create_audio_track", -1);
      expect(newTrack.set).toHaveBeenCalledWith("name", "Resample");
      expect(result.trackIndex).toBe(1);
    });

    it("auto-finds empty scene when sceneIndex not provided", () => {
      setupLiveSet({
        tempo: 120,
        signature_numerator: 4,
        trackIds: ["1"],
        sceneIds: ["100", "101"],
      });
      setupAudioTrack(0, {
        id: "1",
        inputRoutingTypeName: "Resampling",
      });
      // First slot has a clip, second is empty
      setupClipSlot(0, 0, { hasClip: 1 });
      setupClipSlot(0, 1, { hasClip: 0 });

      const result = listenStart({ trackIndex: 0, duration: "4:0" });

      expect(result.sceneIndex).toBe(1);
    });

    it("creates a new scene when all slots are full", () => {
      const liveSet = registerMockObject("live_set-full", {
        path: "live_set",
        type: "Song",
        properties: {
          tempo: 120,
          signature_numerator: 4,
          tracks: ["id", "1"],
          scenes: ["id", "100"],
        },
        methods: {
          create_scene: () => null,
        },
      });

      setupAudioTrack(0, {
        id: "1",
        inputRoutingTypeName: "Resampling",
      });
      // Only scene 0, already occupied
      setupClipSlot(0, 0, { hasClip: 1 });
      // Scene 1 created by create_scene
      setupClipSlot(0, 1, { hasClip: 0 });

      liveSet.get.mockImplementation((prop: string) => {
        if (prop === "scenes") return ["id", "100"];
        if (prop === "tracks") return ["id", "1"];
        if (prop === "tempo") return [120];
        if (prop === "signature_numerator") return [4];

        return [0];
      });

      const result = listenStart({ trackIndex: 0, duration: "4:0" });

      expect(liveSet.call).toHaveBeenCalledWith("create_scene", 1);
      expect(result.sceneIndex).toBe(1);
    });
  });

  describe("duration parsing edge cases", () => {
    it("handles '0:0' duration (zero beats)", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "0:0",
      });

      expect(result.durationMs).toBe(0);
    });

    it("handles '1:3' in 4/4 time (7 beats)", () => {
      setupLiveSet({ tempo: 60, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "1:3" = 1×4 + 3 = 7 beats; 7/60 × 60000 = 7000ms
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "1:3",
      });

      expect(result.durationMs).toBe(7000);
    });

    it("handles plain '0' duration (zero beats, fallback)", () => {
      setupLiveSet({ tempo: 120, signature_numerator: 4 });
      setupAudioTrack(0);
      setupClipSlot(0, 0, { hasClip: 0 });

      // "0" → Number("0") = 0, which is falsy → falls back to beatsPerBar * 4 = 16
      const result = listenStart({
        trackIndex: 0,
        sceneIndex: 0,
        duration: "0",
      });

      // 16/120 × 60000 = 8000ms
      expect(result.durationMs).toBe(8000);
    });
  });
});

// ─── listenStop tests ─────────────────────────────────────────────────────────

describe("listenStop", () => {
  describe("basic success cases", () => {
    it("returns filePath and clipId on success", () => {
      setupAudioTrack(0);
      setupClip(0, 0, { filePath: "/path/to/recording.wav", id: "clip-123" });
      setupClipSlot(0, 0, { hasClip: 1 });

      const result = listenStop({ trackIndex: 0, sceneIndex: 0 });

      expect(result.filePath).toBe("/path/to/recording.wav");
      expect(result.clipId).toBe("clip-123");
    });

    it("calls stop_all_clips on the track", () => {
      const track = setupAudioTrack(0);

      setupClip(0, 0);
      setupClipSlot(0, 0);

      listenStop({ trackIndex: 0, sceneIndex: 0 });

      expect(track.call).toHaveBeenCalledWith("stop_all_clips");
    });

    it("calls delete_clip on the clip slot to release file lock", () => {
      setupAudioTrack(0);
      setupClip(0, 0, { filePath: "/tmp/rec.wav" });
      const slot = setupClipSlot(0, 0);

      listenStop({ trackIndex: 0, sceneIndex: 0 });

      expect(slot.call).toHaveBeenCalledWith("delete_clip");
    });

    it("works with different track and scene indices", () => {
      setupAudioTrack(2);
      setupClip(2, 1, { filePath: "/tmp/track2-scene1.wav", id: "clip-t2s1" });
      setupClipSlot(2, 1);

      const result = listenStop({ trackIndex: 2, sceneIndex: 1 });

      expect(result.filePath).toBe("/tmp/track2-scene1.wav");
    });
  });

  describe("error cases", () => {
    it("throws when no clip is found after recording", () => {
      setupAudioTrack(0);
      // Register a non-existent clip (ID "0")
      registerMockObject("0", {
        path: livePath.track(0).clipSlot(0).clip(),
        type: "Clip",
      });

      expect(() => {
        listenStop({ trackIndex: 0, sceneIndex: 0 });
      }).toThrow("no clip found after recording");
    });

    it("throws when recorded clip has no file path (empty string)", () => {
      setupAudioTrack(0);
      setupClip(0, 0, { filePath: "" }); // empty file path
      setupClipSlot(0, 0);

      expect(() => {
        listenStop({ trackIndex: 0, sceneIndex: 0 });
      }).toThrow("recorded clip has no file path");
    });

    it("error message includes track/scene indices for debugging", () => {
      setupAudioTrack(2);
      registerMockObject("0", {
        path: livePath.track(2).clipSlot(3).clip(),
        type: "Clip",
      });

      expect(() => {
        listenStop({ trackIndex: 2, sceneIndex: 3 });
      }).toThrow("2/3");
    });
  });
});
