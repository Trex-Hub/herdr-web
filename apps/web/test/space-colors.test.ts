import { describe, expect, it } from "vitest"
import { ANSI_HUES, tileFor } from "@/lib/space-colors"

const lightnessAndChroma = (css: string) => /^oklch\(([\d.]+) ([\d.]+) /.exec(css)!.slice(1, 3)

describe("tileFor", () => {
  it("ansi1…ansi6 are red, green, yellow, blue, magenta and cyan: six different hues", () => {
    expect(Object.keys(ANSI_HUES)).toEqual(["ansi1", "ansi2", "ansi3", "ansi4", "ansi5", "ansi6"])
    expect(new Set(Object.values(ANSI_HUES)).size).toBe(6)
    const hue = (n: number) => ANSI_HUES[`ansi${n}`]!
    expect([hue(1), hue(2), hue(3), hue(4), hue(5), hue(6)].map((h) => (h < 60 || h > 340 ? "red" : h < 110 ? "yellow" : h < 170 ? "green" : h < 230 ? "cyan" : h < 300 ? "blue" : "magenta"))).toEqual(["red", "green", "yellow", "blue", "magenta", "cyan"])
  })

  it("every ansi colour has the same lightness and chroma", () => {
    const set = new Set(Object.keys(ANSI_HUES).map((c) => lightnessAndChroma(tileFor("x", c).background).join(" ")))
    expect(set.size).toBe(1)
    expect([...set][0]).toBe(lightnessAndChroma(tileFor("anything").background).join(" ")) // and the same as the hash colour
  })

  it("the bright ansi9…ansi14 map to the same six hues; an unknown or missing colour falls back to the name's hash colour", () => {
    expect(tileFor("x", "ansi9").background).toBe(tileFor("x", "ansi1").background)
    expect(tileFor("x", "ansi14").background).toBe(tileFor("x", "ansi6").background)
    for (const c of ["ansi0", "ansi7", "ansi8", "ansi15", "red", "", "ansi", "#ff0000", undefined]) expect(tileFor("space", c).background).toBe(tileFor("space").background)
    expect(tileFor("space").background).not.toBe(tileFor("another one").background)
  })

  it("is stable for a name", () => {
    expect(tileFor("herdr-web")).toEqual(tileFor("herdr-web"))
  })

  it("the letter reads on every tile: at least 4.5:1, for the six colours and for the hash hues", () => {
    for (const c of Object.keys(ANSI_HUES)) expect(tileFor("x", c).ratio, c).toBeGreaterThanOrEqual(4.5)
    for (let i = 0; i < 360; i++) expect(tileFor(`space-${i}`).ratio, `space-${i}`).toBeGreaterThanOrEqual(4.5)
  })

  it("uses dark ink on these light hues", () => {
    expect(tileFor("x", "ansi3").color).not.toBe("white")
  })
})
