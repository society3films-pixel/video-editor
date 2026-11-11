/**
 * Plays the edit's generated sounds in the editor preview, so pacing can be judged before saving:
 * the whoosh/hit effects as playback crosses them, and a tone over bleeped words.
 */
import { soundEffectEvents, synthesizeEffect, type SoundEffectKind } from "./audio-extras.util";
import { soundEffectsActive, type ClipEdit } from "./clip-edit.util";
import { renderSegmentsFor } from "./hook.util";

export class PreviewSounds {
  private context: AudioContext | null = null;
  private buffers = new Map<SoundEffectKind, AudioBuffer>();
  private lastOutputTime = -1;
  private tone: { oscillator: OscillatorNode; gain: GainNode } | null = null;

  private audio(): AudioContext | null {
    if (!this.context) {
      try {
        this.context = new AudioContext();
      } catch {
        return null;
      }
    }
    if (this.context.state === "suspended") void this.context.resume().catch(() => {});
    return this.context;
  }

  private play(kind: SoundEffectKind, volume: number): void {
    const context = this.audio();
    if (!context) return;
    let buffer = this.buffers.get(kind);
    if (!buffer) {
      const samples = synthesizeEffect(kind, context.sampleRate);
      buffer = context.createBuffer(1, samples.length, context.sampleRate);
      buffer.copyToChannel(samples, 0);
      this.buffers.set(kind, buffer);
    }
    const source = context.createBufferSource();
    const gain = context.createGain();
    gain.gain.value = volume;
    source.buffer = buffer;
    source.connect(gain).connect(context.destination);
    source.start();
  }

  private setTone(on: boolean, volume: number): void {
    if (on && !this.tone) {
      const context = this.audio();
      if (!context) return;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 1000;
      gain.gain.value = 0.15 * volume;
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      this.tone = { oscillator, gain };
    } else if (!on && this.tone) {
      this.tone.oscillator.stop();
      this.tone = null;
    }
  }

  /**
   * Call every frame. `outputTime` is the main edit's output time, `localTime` the clip-local
   * time (for bleeps). Returns true when the voice should be muted (a bleep is playing).
   */
  update(edit: ClipEdit, playing: boolean, outputTime: number, localTime: number): boolean {
    if (!playing) {
      this.lastOutputTime = -1;
      this.setTone(false, 0);
      return false;
    }
    if (soundEffectsActive(edit) && edit.sfx && this.lastOutputTime >= 0 && outputTime > this.lastOutputTime && outputTime - this.lastOutputTime < 0.5) {
      // Events in main-edit time: the hook (if any) isn't part of the preview timeline.
      const hookLength = edit.hook ? edit.hook.end - edit.hook.start : 0;
      for (const event of soundEffectEvents(renderSegmentsFor(edit), edit.sfx)) {
        const t = event.t - hookLength;
        // Whooshes start a little before their cut.
        const at = event.kind === "whoosh" ? t - 0.24 : t;
        if (at > this.lastOutputTime && at <= outputTime) this.play(event.kind, edit.sfx.volume * Math.min(1, edit.volume || 1));
      }
    }
    this.lastOutputTime = outputTime;
    const bleeping = Boolean(edit.bleeps?.some((range) => localTime >= range.start && localTime < range.end));
    this.setTone(bleeping, Math.min(1, edit.volume));
    return bleeping;
  }

  dispose(): void {
    this.setTone(false, 0);
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
