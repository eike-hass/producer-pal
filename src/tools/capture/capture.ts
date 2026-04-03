// Producer Pal
// Copyright (C) 2026 Adam Murray
// AI assistance: Claude (Anthropic)
// SPDX-License-Identifier: GPL-3.0-or-later

import { livePath } from "#src/shared/live-api-path-builders.ts";

const CAPTURE_TRACK_NAME = "_PP Capture";
const MAX_DURATION_MS = 120_000; // 2 minutes max

interface RoutingType {
  display_name: string;
  identifier: number;
}

interface CaptureStartArgs {
  duration?: string;
  source?: number | "master";
}

interface CaptureStartResult {
  captureTrackIndex: number;
  durationMs: number;
  tempo: number;
  sourceName: string;
  projectName: string;
}

/**
 * Set up routing for the capture track and compute recording duration.
 * Returns params needed by the Node handler to send capture_start to the device.
 * @param args - Configuration for capture
 * @param args.duration - Duration in bar:beat format (e.g., "4:0" for 4 bars)
 * @param args.source - Track index for per-track capture, or "master"/"omitted" for full mix
 * @returns Capture track index, duration in ms, and current tempo
 */
export function captureStart(args: CaptureStartArgs): CaptureStartResult {
  const liveSet = LiveAPI.from(livePath.liveSet);
  const tempo = liveSet.getProperty("tempo") as number;
  const timeSigNumerator = liveSet.getProperty("signature_numerator") as number;

  const captureTrackIndex = findOrCreateCaptureTrack(liveSet);
  const track = LiveAPI.from(livePath.track(captureTrackIndex));

  // Arm the track — required for Resampling signal to flow through the Max for Live
  // device chain (plugin~). Monitor:In alone is insufficient; arming is needed even
  // though it's counterintuitive. Output is Sends Only so no feedback or clip recording.
  track.set("arm", 1);

  // Monitor must be "In" (0) so audio flows through the device regardless of arm state
  track.set("current_monitoring_state", 0);

  // Output must be "Sends Only" to prevent feedback and signal doubling
  ensureSendsOnlyOutput(track);

  // Set input routing based on source parameter
  setInputRouting(track, args.source);

  const durationBeats = parseDurationToBeats(
    args.duration ?? "4:0",
    timeSigNumerator,
  );
  const durationMs = Math.min(
    (durationBeats / tempo) * 60_000,
    MAX_DURATION_MS,
  );
  const sourceName = resolveSourceName(args.source);
  const projectName = (liveSet.getProperty("name") as string | null) ?? "";

  return { captureTrackIndex, durationMs, tempo, sourceName, projectName };
}

/**
 * Find an existing _PP Capture track or create one.
 * @param liveSet - LiveAPI for the live set
 * @returns Track index of the capture track
 */
function findOrCreateCaptureTrack(liveSet: LiveAPI): number {
  const trackCount = liveSet.getChildIds("tracks").length;

  for (let i = 0; i < trackCount; i++) {
    const track = LiveAPI.from(livePath.track(i));
    const name = track.getProperty("name") as string | null;

    if (name === CAPTURE_TRACK_NAME) {
      return i;
    }
  }

  // Create a new audio track at the end
  liveSet.call("create_audio_track", -1);
  const newIndex = liveSet.getChildIds("tracks").length - 1;
  const newTrack = LiveAPI.from(livePath.track(newIndex));

  newTrack.set("name", CAPTURE_TRACK_NAME);

  return newIndex;
}

/**
 * Resolve the source argument to a display name for use in filenames.
 * Called after setInputRouting, so per-track source has already been validated.
 * @param source - undefined/"master" for full mix, number for track index
 * @returns Human-readable source name ("master" or the track's name)
 */
function resolveSourceName(source: number | "master" | undefined): string {
  if (source == null || source === "master") return "master";

  const track = LiveAPI.from(livePath.track(source));

  if (!track.exists()) return `track${source}`;

  return (track.getProperty("name") as string | null) ?? `track${source}`;
}

/**
 * Set the input routing of the capture track.
 * @param track - LiveAPI track object
 * @param source - undefined/"master" for Resampling, number for per-track capture
 */
function setInputRouting(
  track: LiveAPI,
  source: number | "master" | undefined,
): void {
  if (source == null || source === "master") {
    ensureMainInput(track);

    return;
  }

  // Per-track routing: find the source track and match its routing option
  const sourceTrack = LiveAPI.from(livePath.track(source));

  if (!sourceTrack.exists()) {
    throw new Error(`capture failed: source track ${source} does not exist`);
  }

  const trackName = sourceTrack.getProperty("name") as string;
  const availableTypes = (track.getProperty("available_input_routing_types") ??
    []) as RoutingType[];

  // Live lists tracks in routing as "Track Name" or "N-Track Name" format
  const matchingType = availableTypes.find((t) =>
    t.display_name.includes(trackName),
  );

  if (!matchingType) {
    throw new Error(
      `capture failed: track "${trackName}" not found in available input routings`,
    );
  }

  track.setProperty("input_routing_type", {
    identifier: matchingType.identifier,
  });
}

/**
 * Ensure the capture track's input is set to "Main" (master mix via device chain).
 * "Resampling" is not used as the primary option because it bypasses the Max for Live
 * device chain, causing plugin~ to receive silence. "Main" routes the master signal
 * through the normal device chain so plugin~ captures the full mix.
 * @param track - LiveAPI track object
 */
function ensureMainInput(track: LiveAPI): void {
  const availableTypes = (track.getProperty("available_input_routing_types") ??
    []) as RoutingType[];

  // "Main" routes the master track signal through the device chain (plugin~ receives it).
  // "Resampling" bypasses the device chain — plugin~ sees silence with that routing.
  const mainType = availableTypes.find((t) => t.display_name === "Main");

  if (mainType) {
    track.setProperty("input_routing_type", {
      identifier: mainType.identifier,
    });

    return;
  }

  // Fallback to Resampling if Main is not available
  const resamplingType = availableTypes.find(
    (t) => t.display_name === "Resampling",
  );

  if (!resamplingType) {
    throw new Error(
      `capture failed: no suitable input routing (Main or Resampling) available on this track`,
    );
  }

  track.setProperty("input_routing_type", {
    identifier: resamplingType.identifier,
  });
}

/**
 * Ensure the capture track's output is set to "Sends Only" to prevent signal doubling.
 * @param track - LiveAPI track object
 */
function ensureSendsOnlyOutput(track: LiveAPI): void {
  const outputType = track.getProperty(
    "output_routing_type",
  ) as RoutingType | null;

  if (outputType?.display_name === "Sends Only") return;

  const availableTypes = (track.getProperty("available_output_routing_types") ??
    []) as RoutingType[];

  const sendsOnly = availableTypes.find((t) => t.display_name === "Sends Only");

  if (!sendsOnly) {
    throw new Error(
      `capture failed: "Sends Only" output routing not available on the capture track — ` +
        `audio would route to master, causing signal doubling`,
    );
  }

  track.setProperty("output_routing_type", {
    identifier: sendsOnly.identifier,
  });
}

/**
 * Parse a duration string to beats.
 * Supports bar:beat format (e.g., "4:0" = 4 bars) or plain beats (e.g., "8").
 * @param duration - Duration string
 * @param beatsPerBar - Beats per bar from time signature
 * @returns Duration in beats
 */
export function parseDurationToBeats(
  duration: string,
  beatsPerBar: number,
): number {
  if (duration.includes(":")) {
    const [bars, beats] = duration.split(":").map(Number);

    return (bars ?? 0) * beatsPerBar + (beats ?? 0);
  }

  return Number(duration) || beatsPerBar * 4; // default 4 bars
}
