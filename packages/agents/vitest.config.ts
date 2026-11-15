import { defineConfig } from "vitest/config"

// `live/` needs a real pi and a scratch core: it is run by `pnpm test:agents`, not by `pnpm test`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } })
