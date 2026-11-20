import { describe, expect, it } from "vitest"
import { mainArgument as extensionMain } from "../../../../packages/pi-extension/src/index"
import { mainArgument as webMain } from "@/lib/chat/format"

// The extension decides on the wire what a tool is "about"; the web shows the same one on the
// tool's line. Both must pick the same argument from the same call.
describe("the extension and the web pick the same main argument", () => {
  const cases = [
    { name: "bash", args: { command: "node scripts/import.js exports/2026-03.csv", cwd: "/tmp" } },
    { name: "bash", args: { command: "pnpm test\n--run only", cwd: "/work/app" } },
    { name: "read", args: { path: "src/import.ts" } },
    { name: "edit", args: { file_path: "src/a.ts", oldText: "x", newText: "y" } },
    { name: "grep", args: { pattern: "TODO", path: "src" } },
    { name: "search", args: { query: "cats" } },
    { name: "tool", args: { n: 1, label: "hello" } },
    { name: "tool", args: {} },
    { name: "tool", args: { n: 1 } },
    // Over the 200-character cut both must agree on the truncated argument.
    { name: "bash", args: { command: `node run ${'a'.repeat(300)}` } },
    { name: "read", args: { path: `src/${'b'.repeat(250)}.ts` } },
  ]
  for (const c of cases) {
    it(`for ${c.name} ${JSON.stringify(c.args)}`, () => {
      expect(webMain(c)).toBe(extensionMain(c.args))
    })
  }
})