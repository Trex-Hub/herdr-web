import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  // The browser test runs its own dev server beside yours, with its own build folder.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Keep Next from writing AGENTS.md / CLAUDE.md into the tree on `next dev`.
  agentRules: false,
  devIndicators: false,
}

export default nextConfig
