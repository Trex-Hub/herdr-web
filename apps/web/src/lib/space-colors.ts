/**
 * The colours of a space's tile. herdr-app names a space's colour `ansi1`…`ansi6` (and `ansi9`…`ansi14`, the bright ones);
 * those map to six hues at one lightness and chroma, so they sit quietly on both themes. A space with no (known) colour
 * gets a hue from its name, as it always did.
 */
const LIGHTNESS = 0.62
const CHROMA = 0.12

export const ANSI_HUES: Readonly<Record<string, number>> = {
  ansi1: 25, // red
  ansi2: 145, // green
  ansi3: 90, // yellow
  ansi4: 255, // blue
  ansi5: 330, // magenta
  ansi6: 200, // cyan
}

function hueOfName(name: string): number {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) % 360
  return h
}

function ansiHue(colour: string | undefined): number | null {
  if (!colour) return null
  const m = /^ansi(\d+)$/.exec(colour)
  if (!m) return null
  const n = Number(m[1])
  const hue = ANSI_HUES[`ansi${n >= 9 && n <= 14 ? n - 8 : n}`]
  return hue ?? null
}

// --- contrast ---------------------------------------------------------------

/** WCAG relative luminance of an oklch colour, clipped into sRGB. */
function luminance(l: number, c: number, hueDeg: number): number {
  const h = (hueDeg * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  const lin = [4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_, -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_, -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_]
  const [r, g, bl] = lin.map((v) => Math.min(1, Math.max(0, v))) as [number, number, number]
  return 0.2126 * r + 0.7152 * g + 0.0722 * bl
}

export function contrast(y1: number, y2: number): number {
  const [hi, lo] = y1 > y2 ? [y1, y2] : [y2, y1]
  return (hi + 0.05) / (lo + 0.05)
}

const INK_DARK = { css: "oklch(0.18 0.02 0)", l: 0.18 }

export interface Tile {
  background: string
  color: string
  /** Contrast of `color` on `background`, for tests. */
  ratio: number
}

/** A tile's colours: its background, and the lighter or darker ink that reads better on it. */
export function tileFor(name: string, colour?: string): Tile {
  const hue = ansiHue(colour) ?? hueOfName(name)
  const y = luminance(LIGHTNESS, CHROMA, hue)
  const white = contrast(y, 1)
  const dark = contrast(y, luminance(INK_DARK.l, 0.02, 0))
  return {
    background: `oklch(${LIGHTNESS} ${CHROMA} ${hue})`,
    color: dark >= white ? INK_DARK.css : "white",
    ratio: Math.max(dark, white),
  }
}
