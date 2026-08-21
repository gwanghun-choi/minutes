import type { Speaker } from "../api/types";

const COLORS = 8;

/**
 * Same speaker, same colour, everywhere on the page. Keyed on speaker_code and
 * derived from the meeting's own speaker order, so it is stable across renders.
 */
export function speakerColors(speakers: Speaker[]): Map<string, string> {
  return new Map(speakers.map((s, i) => [s.speaker_code, `var(--color-spk-${i % COLORS})`]));
}

export function speakerName(s: { display_name: string | null; speaker_code: string | null }): string {
  return s.display_name || s.speaker_code || "-";
}
