/**
 * Fast normalised cross-correlation (FFT), for lining recordings up by their sound. Finds where
 * a short stretch of one recording sits in another, in one pass over every possible lag.
 */

/** In-place radix-2 FFT (re, im of length 2^k). `inverse` scales by 1/n. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        const next = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = next;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i]! /= n;
      im[i]! /= n;
    }
  }
}

export interface LagScore {
  lag: number;
  score: number;
}

/**
 * Normalised correlation of `reference` against `target` at every lag where at least half of
 * the reference overlaps: target[i + lag] ≈ reference[i]. Optional [minLag, maxLag] limits the
 * search (e.g. around a timecode guess). Returns the best lag and up to `keep` runner-up peaks
 * (at least `separation` steps apart), best first.
 */
export function correlatePeaks(
  reference: Float32Array,
  target: Float32Array,
  options: {
    minLag?: number;
    maxLag?: number;
    keep?: number;
    separation?: number;
  } = {},
): LagScore[] {
  const n = reference.length;
  const m = target.length;
  if (!n || !m) return [];
  let size = 1;
  while (size < n + m) size <<= 1;
  const ar = new Float64Array(size);
  const ai = new Float64Array(size);
  const br = new Float64Array(size);
  const bi = new Float64Array(size);
  for (let i = 0; i < n; i++) ar[i] = reference[i]!;
  for (let i = 0; i < m; i++) br[i] = target[i]!;
  fft(ar, ai, false);
  fft(br, bi, false);
  // conj(A) * B
  for (let k = 0; k < size; k++) {
    const r = ar[k]! * br[k]! + ai[k]! * bi[k]!;
    const i = ar[k]! * bi[k]! - ai[k]! * br[k]!;
    ar[k] = r;
    ai[k] = i;
  }
  fft(ar, ai, true);
  // Sliding energy of the target.
  const prefix = new Float64Array(m + 1);
  for (let i = 0; i < m; i++)
    prefix[i + 1] = prefix[i]! + target[i]! * target[i]!;
  let refEnergy = 0;
  for (const v of reference) refEnergy += v * v;
  const refNorm = Math.sqrt(refEnergy) || 1;
  const minLag = Math.max(-Math.floor(n / 2), options.minLag ?? -Infinity);
  const maxLag = Math.min(m - Math.ceil(n / 2), options.maxLag ?? Infinity);
  const scores: LagScore[] = [];
  for (let lag = Math.ceil(minLag); lag <= maxLag; lag++) {
    const from = Math.max(0, lag);
    const to = Math.min(m, lag + n);
    if (to - from < n / 2) continue;
    const dot = ar[(lag + size) % size]!;
    const norm = Math.sqrt(Math.max(0, prefix[to]! - prefix[from]!)) || 1;
    scores.push({ lag, score: dot / (refNorm * norm) });
  }
  const keep = options.keep ?? 1;
  const separation = options.separation ?? 25;
  const peaks: LagScore[] = [];
  for (const candidate of [...scores].sort((a, b) => b.score - a.score)) {
    if (peaks.length >= keep) break;
    if (peaks.every((p) => Math.abs(p.lag - candidate.lag) >= separation))
      peaks.push(candidate);
  }
  return peaks;
}

/** Parabolic interpolation around a peak: a fractional lag (sub-step precision). */
export function refinePeak(
  reference: Float32Array,
  target: Float32Array,
  lag: number,
): number {
  const at = (l: number) =>
    correlatePeaks(reference, target, { minLag: l, maxLag: l })[0]?.score ?? 0;
  const left = at(lag - 1);
  const mid = at(lag);
  const right = at(lag + 1);
  const denom = left - 2 * mid + right;
  if (denom >= 0) return lag;
  return lag + Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denom));
}
