import { defineConfig } from "vitest/config"

// The live check: a real pi on a scratch core, talking to this package's side of the agents socket.
export default defineConfig({
  test: {
    include: ["live/**/*.live.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
