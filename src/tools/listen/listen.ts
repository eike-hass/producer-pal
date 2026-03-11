// Producer Pal
// Copyright (C) 2026 Adam Murray, Eike Haß
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { livePath } from "#src/shared/live-api-path-builders.ts";

interface RoutingType {
  display_name: string;
  identifier: number;
}

interface ListenStartArgs {
  trackIndex?: number;
  sceneIndex?: number;
  duration: string;
}

interface ListenStartResult {
  trackIndex: number;
  sceneIndex: number;
  durationMs: number;
  tempo: number;
}

interface ListenStopArgs {
  trackIndex: number;
  sceneIndex: number;
}

interface ListenStopResult {
  filePath: string;
  clipId: string;
}

/**
 * Start recording on a resampling track by firing an empty clip slot.
 * Sets up the track for resampling if needed, then fires the clip slot.
 * @param args - Configuration for recording
 * @param args.trackIndex - Track index of the resampling track
 * @param args.sceneIndex - Scene index for the clip slot (default: 0)
 * @param args.duration - Duration in bar:beat format (e.g., "4:0" for 4 bars)
 * @returns Info needed by the Node-side handler to wait and stop
 */
export function listenStart(args: ListenStartArgs): ListenStartResult {
  const liveSet = LiveAPI.from(livePath.liveSet);
  const tempo = liveSet.getProperty("tempo") as number;
  const timeSigNumerator = liveSet.getProperty("signature_numerator") as number;

  const trackIndex = args.trackIndex ?? findOrCreateResampleTrack();
  const track = LiveAPI.from(livePath.track(trackIndex));

  if (!track.exists()) {
    throw new Error(`listen failed: track ${trackIndex} does not exist`);
  }

  // Verify it's an audio track
  if (!track.getProperty("has_audio_input")) {
    throw new Error(`listen failed: track ${trackIndex} is not an audio track`);
  }

  // Set input routing to Resampling if not already set
  ensureResamplingInput(track);

  // Arm the track
  track.set("arm", 1);

  // Parse duration (bar:beat format like "4:0" or just beats like "8")
  const durationBeats = parseDurationToBeats(args.duration, timeSigNumerator);
  const durationMs = (durationBeats / tempo) * 60_000;

  // Find the target scene index
  const sceneIndex = args.sceneIndex ?? findEmptySlot(trackIndex);
  const clipSlot = LiveAPI.from(
    livePath.track(trackIndex).clipSlot(sceneIndex),
  );

  if (!clipSlot.exists()) {
    throw new Error(
      `listen failed: clip slot ${trackIndex}/${sceneIndex} does not exist`,
    );
  }

  // Check the slot is empty
  const hasClip = (clipSlot.getProperty("has_clip") as number) > 0;

  if (hasClip) {
    throw new Error(
      `listen failed: clip slot ${trackIndex}/${sceneIndex} already has a clip`,
    );
  }

  // Fire the empty clip slot to start recording
  clipSlot.call("fire");

  return { trackIndex, sceneIndex, durationMs, tempo };
}

/**
 * Stop recording and return the file path of the captured audio.
 * @param args - Info about the recording to stop
 * @param args.trackIndex - Track index of the resampling track
 * @param args.sceneIndex - Scene index of the recorded clip slot
 * @returns File path and clip ID
 */
export function listenStop(args: ListenStopArgs): ListenStopResult {
  const { trackIndex, sceneIndex } = args;

  // Stop the track's clips (this stops recording)
  const track = LiveAPI.from(livePath.track(trackIndex));

  track.call("stop_all_clips");

  // Read the resulting clip
  const clip = LiveAPI.from(
    livePath.track(trackIndex).clipSlot(sceneIndex).clip(),
  );

  if (!clip.exists()) {
    throw new Error(
      `listen failed: no clip found after recording at ${trackIndex}/${sceneIndex}`,
    );
  }

  const filePath = clip.getProperty("file_path") as string;

  if (!filePath || filePath.length === 0) {
    throw new Error(`listen failed: recorded clip has no file path`);
  }

  // Delete the clip to release Ableton's exclusive file lock on the WAV
  const clipSlot = LiveAPI.from(
    livePath.track(trackIndex).clipSlot(sceneIndex),
  );

  clipSlot.call("delete_clip");

  return { filePath, clipId: clip.id };
}

/**
 * Find an existing audio track set to Resampling, or create one.
 * @returns Track index of the resampling track
 */
function findOrCreateResampleTrack(): number {
  const liveSet = LiveAPI.from(livePath.liveSet);
  const trackCount = liveSet.getChildIds("tracks").length;

  // Look for an existing track with Resampling input
  for (let i = 0; i < trackCount; i++) {
    const track = LiveAPI.from(livePath.track(i));
    const hasAudioInput = track.getProperty("has_audio_input") as number;

    if (!hasAudioInput) continue;

    const inputType = track.getProperty(
      "input_routing_type",
    ) as RoutingType | null;

    if (inputType?.display_name === "Resampling") {
      return i;
    }
  }

  // No resampling track found — create one
  liveSet.call("create_audio_track", -1);
  const newIndex = liveSet.getChildIds("tracks").length - 1;
  const newTrack = LiveAPI.from(livePath.track(newIndex));

  newTrack.set("name", "Resample");
  ensureResamplingInput(newTrack);

  return newIndex;
}

/**
 * Ensure a track's input routing is set to Resampling.
 * @param track - LiveAPI track object
 */
function ensureResamplingInput(track: LiveAPI): void {
  const inputType = track.getProperty(
    "input_routing_type",
  ) as RoutingType | null;

  if (inputType?.display_name !== "Resampling") {
    const availableTypes = (track.getProperty(
      "available_input_routing_types",
    ) ?? []) as RoutingType[];

    const resamplingType = availableTypes.find(
      (t) => t.display_name === "Resampling",
    );

    if (!resamplingType) {
      throw new Error(
        `listen failed: Resampling input routing not available on this track`,
      );
    }

    track.setProperty("input_routing_type", {
      identifier: resamplingType.identifier,
    });
  }
}

/**
 * Find the first empty clip slot on a track.
 * @param trackIndex - Track index
 * @returns Scene index of the first empty slot
 */
function findEmptySlot(trackIndex: number): number {
  const liveSet = LiveAPI.from(livePath.liveSet);
  const sceneCount = liveSet.getChildIds("scenes").length;

  for (let i = 0; i < sceneCount; i++) {
    const clipSlot = LiveAPI.from(livePath.track(trackIndex).clipSlot(i));
    const hasClip = (clipSlot.getProperty("has_clip") as number) > 0;

    if (!hasClip) return i;
  }

  // All slots full — create a new scene
  liveSet.call("create_scene", sceneCount);

  return sceneCount;
}

/**
 * Parse a duration string to beats.
 * Supports bar:beat format (e.g., "4:0" = 4 bars) or plain beats (e.g., "8").
 * @param duration - Duration string
 * @param beatsPerBar - Beats per bar from time signature
 * @returns Duration in beats
 */
function parseDurationToBeats(duration: string, beatsPerBar: number): number {
  if (duration.includes(":")) {
    const [bars, beats] = duration.split(":").map(Number);

    return (bars ?? 0) * beatsPerBar + (beats ?? 0);
  }

  return Number(duration) || beatsPerBar * 4; // default 4 bars
}
