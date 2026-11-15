import type { Display } from "@herdr-web/protocol"

/** What xterm needs to colour a terminal; all values are `#rrggbb` (xterm cannot read oklch). */
export interface TerminalPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  /** The scrollbar's thumb (there is no track): quiet, and the same hue as the text so it reads on either theme. */
  scrollbarSliderBackground: string
  scrollbarSliderHoverBackground: string
  scrollbarSliderActiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

/** The ANSI sixteen for each theme: light needs darker colours than dark to stay readable on white. */
const DARK_ANSI = {
  black: "#3f3f46",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#d4d4d8",
  brightBlack: "#71717a",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#fafafa",
}

const LIGHT_ANSI = {
  black: "#27272a",
  red: "#b91c1c",
  green: "#15803d",
  yellow: "#a16207",
  blue: "#1d4ed8",
  magenta: "#7e22ce",
  cyan: "#0e7490",
  white: "#71717a",
  brightBlack: "#52525b",
  brightRed: "#dc2626",
  brightGreen: "#16a34a",
  brightYellow: "#ca8a04",
  brightBlue: "#2563eb",
  brightMagenta: "#9333ea",
  brightCyan: "#0891b2",
  brightWhite: "#18181b",
}

const hex = (n: number) => n.toString(16).padStart(2, "0")

/** Any CSS colour the browser understands (oklch included) as `#rrggbb`, or null. */
export function cssToHex(css: string): string | null {
  if (typeof document === "undefined") return null
  const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true })
  if (!ctx) return null
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = "#000"
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data
  if (a === undefined || r === undefined || g === undefined || b === undefined || a < 255) return null
  return `#${hex(r)}${hex(g)}${hex(b)}`
}

/** The palette for the page's current theme, background and text taken from the app's own variables so the terminal blends in. */
export function currentPalette(dark: boolean, style: CSSStyleDeclaration = getComputedStyle(document.documentElement)): TerminalPalette {
  const background = cssToHex(style.getPropertyValue("--background").trim()) ?? (dark ? "#0a0a0a" : "#ffffff")
  const foreground = cssToHex(style.getPropertyValue("--foreground").trim()) ?? (dark ? "#fafafa" : "#0a0a0a")
  return {
    background,
    foreground,
    cursor: foreground,
    cursorAccent: background,
    selectionBackground: dark ? "#3b82f666" : "#3b82f655",
    scrollbarSliderBackground: dark ? "#ffffff33" : "#00000033",
    scrollbarSliderHoverBackground: dark ? "#ffffff55" : "#00000055",
    scrollbarSliderActiveBackground: dark ? "#ffffff77" : "#00000077",
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
  }
}

/** What core is told the viewer looks like, from the palette and the rendered cell size in device pixels. */
export function displayFacts(palette: TerminalPalette, cell: { width: number; height: number } | null): Display {
  const ok = cell && cell.width >= 1 && cell.height >= 1
  return {
    fg: palette.foreground,
    bg: palette.background,
    cursor: palette.cursor,
    cell: ok ? [Math.round(cell.width), Math.round(cell.height)] : null,
  }
}
