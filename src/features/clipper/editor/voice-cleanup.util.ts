/**
 * Voice clean-up for the saved edit: removes rumble (high-pass), pushes down background noise
 * between words (a downward expander that tracks the noise floor), and evens out the level (a
 * compressor with make-up gain). Streaming, chunk by chunk, one state per channel.
 */
export interface VoiceCleanupSettings {
  /** Lower background noise between words. */
  denoise: boolean;
  /** Even out loud and quiet words. */
  compress: boolean;
}

const HIGH_PASS_HZ = 80;

class ChannelState {
  // Biquad high-pass state.
  x1 = 0;
  x2 = 0;
  y1 = 0;
  y2 = 0;
  envelope = 0;
  noiseFloor = 0.01;
  gateGain = 1;
  compEnvelope = 0;
}

export class VoiceCleanup {
  private readonly states: ChannelState[] = [];
  private readonly b0: number;
  private readonly b1: number;
  private readonly b2: number;
  private readonly a1: number;
  private readonly a2: number;
  private readonly attack: number;
  private readonly release: number;
  private readonly floorRise: number;
  private readonly floorFall: number;
  private readonly gateOpen: number;
  private readonly gateClose: number;
  private readonly compAttack: number;
  private readonly compRelease: number;

  constructor(
    private readonly settings: VoiceCleanupSettings,
    sampleRate: number,
  ) {
    // RBJ high-pass, Q = 0.707.
    const w = (2 * Math.PI * HIGH_PASS_HZ) / sampleRate;
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const cos = Math.cos(w);
    const a0 = 1 + alpha;
    this.b0 = (1 + cos) / 2 / a0;
    this.b1 = -(1 + cos) / a0;
    this.b2 = (1 + cos) / 2 / a0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
    const coefficient = (seconds: number) => 1 - Math.exp(-1 / (seconds * sampleRate));
    this.attack = coefficient(0.005);
    this.release = coefficient(0.08);
    // The floor follows quiet passages down fairly quickly and creeps up slowly, so it settles
    // on the noise between words rather than the speech.
    this.floorFall = coefficient(0.2);
    this.floorRise = coefficient(6);
    this.gateOpen = coefficient(0.004);
    this.gateClose = coefficient(0.12);
    this.compAttack = coefficient(0.006);
    this.compRelease = coefficient(0.15);
  }

  /** Processes planar float audio in place. */
  process(planar: Float32Array, channels: number, frameCount: number): void {
    while (this.states.length < channels) this.states.push(new ChannelState());
    for (let c = 0; c < channels; c++) {
      const s = this.states[c]!;
      const offset = c * frameCount;
      for (let i = 0; i < frameCount; i++) {
        const x = planar[offset + i]!;
        let y = this.b0 * x + this.b1 * s.x1 + this.b2 * s.x2 - this.a1 * s.y1 - this.a2 * s.y2;
        s.x2 = s.x1;
        s.x1 = x;
        s.y2 = s.y1;
        s.y1 = y;

        const level = Math.abs(y);
        s.envelope += (level - s.envelope) * (level > s.envelope ? this.attack : this.release);

        if (this.settings.denoise) {
          s.noiseFloor += (s.envelope - s.noiseFloor) * (s.envelope < s.noiseFloor ? this.floorFall : this.floorRise);
          // Anything louder than about -34 dBFS isn't background noise.
          s.noiseFloor = Math.min(0.02, Math.max(1e-5, s.noiseFloor));
          // Below ~3x the floor (noise between words) the level is pushed down, at most -18 dB.
          const threshold = s.noiseFloor * 3;
          const target = s.envelope >= threshold ? 1 : Math.max(0.125, (s.envelope / threshold) ** 1.5);
          s.gateGain += (target - s.gateGain) * (target > s.gateGain ? this.gateOpen : this.gateClose);
          y *= s.gateGain;
        }

        if (this.settings.compress) {
          const compLevel = Math.abs(y);
          s.compEnvelope += (compLevel - s.compEnvelope) * (compLevel > s.compEnvelope ? this.compAttack : this.compRelease);
          // -20 dBFS threshold, 3:1, +5 dB make-up.
          const threshold = 0.1;
          const gain = s.compEnvelope > threshold ? (threshold * (s.compEnvelope / threshold) ** (1 / 3)) / s.compEnvelope : 1;
          y *= gain * 1.78;
        }
        planar[offset + i] = Math.max(-1, Math.min(1, y));
      }
    }
  }
}
