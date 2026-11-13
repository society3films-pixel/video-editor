/**
 * Sync check by ear: a few seconds of a camera's own sound and the reference recording, started
 * at the same instant (Web Audio, sample-exact), recorder in the left ear and camera in the
 * right. In sync they sound like one voice in the middle; out of sync you hear a slap or echo.
 */
import { AudioBufferSink } from "mediabunny";
import { createMediabunnyInput } from "../../lib/media/mediabunny-file-source.util";
import { fileFor, type FolderMedia } from "./folder-draft.util";
import { fileTimeOf, masterTimeOf } from "./folder-draft-sync.util";

let playing: { context: AudioContext; stop: () => void } | null = null;

/** Decodes `seconds` of a file's sound from file time `from`, mixed to mono. */
async function snippet(
  media: FolderMedia,
  from: number,
  seconds: number,
  rate: number,
): Promise<Float32Array> {
  const input = await createMediabunnyInput(fileFor(media));
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode()))
      throw new Error(`${media.name}'s sound can't be decoded here.`);
    const out = new Float32Array(Math.round(seconds * rate));
    for await (const { buffer, timestamp } of new AudioBufferSink(
      track,
    ).buffers(Math.max(0, from), from + seconds)) {
      const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) =>
        buffer.getChannelData(c),
      );
      // Only the output samples this buffer covers (nearest-sample resampling is fine for listening).
      const first = Math.max(0, Math.ceil((timestamp - from) * rate));
      const last = Math.min(
        out.length,
        Math.floor(
          (timestamp + buffer.length / buffer.sampleRate - from) * rate,
        ),
      );
      for (let i = first; i < last; i++) {
        const k = Math.round((from + i / rate - timestamp) * buffer.sampleRate);
        if (k < 0 || k >= buffer.length) continue;
        let v = 0;
        for (const data of channels) v += data[k]!;
        out[i] = v / channels.length;
      }
    }
    // Same loudness in both ears.
    let peak = 0;
    for (const v of out) peak = Math.max(peak, Math.abs(v));
    if (peak > 0) for (let i = 0; i < out.length; i++) out[i]! *= 0.7 / peak;
    return out;
  } finally {
    input.dispose();
  }
}

/** Where both recordings run: a master time near the middle of their overlap. */
export function listenPoint(
  item: FolderMedia,
  reference: FolderMedia,
): number | null {
  if (item.offsetSec === null || reference.offsetSec === null) return null;
  const start = Math.max(item.offsetSec, reference.offsetSec);
  const end = Math.min(
    masterTimeOf(item, item.durationSec),
    masterTimeOf(reference, reference.durationSec),
  );
  return end - start > 8 ? (start + end) / 2 : null;
}

export function stopSyncListen(): void {
  playing?.stop();
  playing = null;
}

/** Plays the check; resolves when it ends. */
export async function playSyncListen(
  item: FolderMedia,
  reference: FolderMedia,
  masterTime: number,
  seconds = 6,
): Promise<void> {
  stopSyncListen();
  const rate = 48000;
  const [left, right] = await Promise.all([
    snippet(reference, fileTimeOf(reference, masterTime), seconds, rate),
    snippet(item, fileTimeOf(item, masterTime), seconds, rate),
  ]);
  const context = new AudioContext({ sampleRate: rate });
  const buffer = context.createBuffer(2, left.length, rate);
  buffer.copyToChannel(left as Float32Array<ArrayBuffer>, 0);
  buffer.copyToChannel(right as Float32Array<ArrayBuffer>, 1);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  await new Promise<void>((resolve) => {
    source.onended = () => resolve();
    playing = {
      context,
      stop: () => {
        try {
          source.stop();
        } catch {
          // Already stopped.
        }
        resolve();
      },
    };
    source.start();
  });
  await context.close().catch(() => {});
  if (playing?.context === context) playing = null;
}
