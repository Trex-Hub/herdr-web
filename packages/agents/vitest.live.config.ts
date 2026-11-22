import { defineConfig } from "vitest/config"

// The live check: a real pi on a scratch core, reached through the session files in a pi-live folder of the scratch root, by this package's client.
export default defineConfig({
  test: {
    include: ["live/**/*.live.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
