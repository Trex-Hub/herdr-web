import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const src = path.join(import.meta.dirname, "../src")
const importsOf = (file: string) =>
  [...fs.readFileSync(path.join(src, file), "utf8").matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]!)

describe("rows.ts is for the browser", () => {
  it("imports nothing but zod", () => {
    expect(importsOf("rows.ts")).toEqual(["zod"])
  })

  it("uses no Node global", () => {
    const code = fs.readFileSync(path.join(src, "rows.ts"), "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")
    expect(code).not.toMatch(/\b(process|Buffer|__dirname|require)\b/)
  })

  it("is exported as @herdr-web/agents/rows", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../package.json"), "utf8"))
    expect(Object.keys(pkg.exports)).toEqual([".", "./rows"])
    expect(pkg.exports["./rows"].default).toBe("./dist/rows.js")
  })
})
