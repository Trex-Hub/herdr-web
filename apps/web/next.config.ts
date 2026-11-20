import type { NextConfig } from "next"

// Next only reads .env from apps/web; the shared one is at the repo root. Variables already set in the shell win.
try {
  process.loadEnvFile(new URL("../../.env", import.meta.url))
} catch (e) {
  if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
}

const nextConfig: NextConfig = {
  // The browser test runs its own dev server beside yours, with its own build folder.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep Next from writing AGENTS.md / CLAUDE.md into the tree on `next dev`.
  agentRules: false,
  devIndicators: false,
  // The dev server also answers at 127.0.0.1; without this Next blocks that page's scripts and it never loads.
  allowedDevOrigins: ["127.0.0.1"],
}

export default nextConfig
