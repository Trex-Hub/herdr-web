import path from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "next/font/google": path.resolve(import.meta.dirname, "test/next-font.ts") } },
  // Component tests are .tsx and ask for jsdom with `// @vitest-environment jsdom` at the top of the file.
  test: { include: ["test/**/*.test.{ts,tsx}"], setupFiles: ["./test/setup.ts"] },
})
