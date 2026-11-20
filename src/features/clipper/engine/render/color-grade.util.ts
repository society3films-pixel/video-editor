/**
 * Colour grading for rendered clips: an optional automatic correction (exposure, contrast,
 * saturation, colour cast) measured from the clip, then a look. Applied to the picture only,
 * before captions and branding are drawn, using canvas filters and blend layers so it runs on
 * the GPU in the preview and the render alike.
 */
export type ColorStyle = "none" | "natural" | "warm" | "cool" | "cinematic" | "vibrant" | "moody" | "bw" | "vintage";

export interface ColorCorrection {
  /** Multipliers around 1. */
  brightness: number;
  contrast: number;
  saturation: number;
  /** Colour-cast fix: positive warms, negative cools (-1..1). */
  warmth: number;
}

export interface ColorGrade {
  style: ColorStyle;
  /** How strong the look is, 0..1. */
  intensity: number;
  /** Measured correction applied under the look; null = none. */
  auto: ColorCorrection | null;
}

export const COLOR_STYLE_LABEL: Record<ColorStyle, string> = {
  none: "No look",
  natural: "Natural",
  warm: "Warm",
  cool: "Cool",
  cinematic: "Cinematic",
  vibrant: "Vibrant",
  moody: "Moody",
  bw: "Black & white",
  vintage: "Vintage",
};

interface Look {
  brightness?: number;
  contrast?: number;
  saturate?: number;
  sepia?: number;
  grayscale?: number;
  /** Blend layers over the picture. */
  layers?: Array<{ color: string; alpha: number; mode: GlobalCompositeOperation }>;
}

const LOOKS: Record<ColorStyle, Look> = {
  none: {},
  natural: { contrast: 1.04, saturate: 1.05 },
  warm: { saturate: 1.06, layers: [{ color: "#ff9a50", alpha: 0.28, mode: "soft-light" }] },
  cool: { saturate: 0.98, layers: [{ color: "#4aa3ff", alpha: 0.26, mode: "soft-light" }] },
  cinematic: {
    contrast: 1.12,
    saturate: 0.88,
    layers: [
      { color: "#008c96", alpha: 0.16, mode: "soft-light" },
      { color: "#ff8a30", alpha: 0.06, mode: "overlay" },
    ],
  },
  vibrant: { contrast: 1.06, saturate: 1.38 },
  moody: { brightness: 0.93, contrast: 1.16, saturate: 0.72, layers: [{ color: "#1a2a40", alpha: 0.22, mode: "soft-light" }] },
  bw: { grayscale: 1, contrast: 1.18 },
  vintage: {
    brightness: 1.04,
    contrast: 0.9,
    saturate: 0.8,
    sepia: 0.3,
    layers: [
      { color: "#ffd8a0", alpha: 0.16, mode: "soft-light" },
      { color: "#3a2c20", alpha: 0.1, mode: "screen" },
    ],
  },
};

const mix = (neutral: number, value: number | undefined, amount: number) => neutral + ((value ?? neutral) - neutral) * amount;

/** CSS filter for the picture: correction × look at `intensity`. */
export function colorGradeFilter(grade: ColorGrade): string {
  const look = LOOKS[grade.style] ?? {};
  const k = Math.min(1, Math.max(0, grade.intensity));
  const auto = grade.auto;
  const brightness = (auto?.brightness ?? 1) * mix(1, look.brightness, k);
  const contrast = (auto?.contrast ?? 1) * mix(1, look.contrast, k);
  const saturate = (auto?.saturation ?? 1) * mix(1, look.saturate, k);
  const parts = [
    `brightness(${brightness.toFixed(3)})`,
    `contrast(${contrast.toFixed(3)})`,
    `saturate(${saturate.toFixed(3)})`,
  ];
  if (look.sepia) parts.push(`sepia(${(look.sepia * k).toFixed(3)})`);
  if (look.grayscale) parts.push(`grayscale(${(look.grayscale * k).toFixed(3)})`);
  return parts.join(" ");
}

export function colorGradeLayers(grade: ColorGrade): Array<{ color: string; alpha: number; mode: GlobalCompositeOperation }> {
  const k = Math.min(1, Math.max(0, grade.intensity));
  const layers = (LOOKS[grade.style]?.layers ?? []).map((layer) => ({ ...layer, alpha: layer.alpha * k }));
  const warmth = grade.auto?.warmth ?? 0;
  if (Math.abs(warmth) > 0.02) {
    layers.unshift({ color: warmth > 0 ? "#ff9a50" : "#4aa3ff", alpha: Math.min(0.3, Math.abs(warmth) * 0.3), mode: "soft-light" });
  }
  return layers.filter((layer) => layer.alpha > 0.005);
}

export function isColorGradeActive(grade: ColorGrade | null | undefined): grade is ColorGrade {
  return Boolean(grade && ((grade.style !== "none" && grade.intensity > 0) || grade.auto));
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Draws `draw` (the picture) graded, then the grade's blend layers over `area`. */
export function withColorGrade(
  ctx: Ctx2D,
  grade: ColorGrade | null | undefined,
  area: { x: number; y: number; width: number; height: number },
  draw: () => void,
): void {
  if (!isColorGradeActive(grade)) {
    draw();
    return;
  }
  ctx.save();
  ctx.filter = colorGradeFilter(grade);
  draw();
  ctx.restore();
  const layers = colorGradeLayers(grade);
  if (!layers.length) return;
  ctx.save();
  for (const layer of layers) {
    ctx.globalCompositeOperation = layer.mode;
    ctx.globalAlpha = layer.alpha;
    ctx.fillStyle = layer.color;
    ctx.fillRect(area.x, area.y, area.width, area.height);
  }
  ctx.restore();
}

/**
 * Correction from frame statistics (RGBA pixels of a few small frames): exposure towards a mid
 * level, contrast towards a healthy spread, saturation towards natural colour, and a colour-cast
 * fix from the red/blue balance. Kept gentle so it never looks processed.
 */
export function measureColorCorrection(frames: ReadonlyArray<Uint8ClampedArray>): ColorCorrection | null {
  let count = 0;
  let sumL = 0;
  let sumL2 = 0;
  let sumR = 0;
  let sumB = 0;
  let sumChroma = 0;
  for (const data of frames) {
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]! / 255;
      const g = data[i + 1]! / 255;
      const b = data[i + 2]! / 255;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sumL += l;
      sumL2 += l * l;
      sumR += r;
      sumB += b;
      sumChroma += Math.max(r, g, b) - Math.min(r, g, b);
      count++;
    }
  }
  if (count < 100) return null;
  const meanL = sumL / count;
  const std = Math.sqrt(Math.max(0, sumL2 / count - meanL * meanL));
  const chroma = sumChroma / count;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    brightness: clamp(Math.pow(0.46 / Math.max(0.05, meanL), 0.55), 0.82, 1.3),
    contrast: clamp(Math.pow(0.22 / Math.max(0.03, std), 0.45), 0.88, 1.22),
    saturation: clamp(Math.pow(0.2 / Math.max(0.02, chroma), 0.4), 0.85, 1.3),
    warmth: clamp(((sumB - sumR) / count) * 2.5, -0.6, 0.6),
  };
}
