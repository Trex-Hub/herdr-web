import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** `$PI_CODING_AGENT_DIR` or `~/.pi/agent`: the rule pi-live and pi itself use. */
function agentDir(env: NodeJS.ProcessEnv): string {
  const override = env["PI_CODING_AGENT_DIR"]?.trim();
  return override ? override : path.join(os.homedir(), ".pi", "agent");
}

/**
 * The folder pi-live writes its session files to, by pi-live's own rule: `$PI_LIVE_DIR`, else `dir` in
 * `<agent dir>/pi-live.json`, else `<agent dir>/live`. The backend asks here, once, and nowhere else.
 */
export function piLiveDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env["PI_LIVE_DIR"]?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  try {
    const settings: unknown = JSON.parse(fs.readFileSync(path.join(agentDir(env), "pi-live.json"), "utf8"));
    const dir = typeof settings === "object" && settings !== null ? (settings as { dir?: unknown }).dir : undefined;
    if (typeof dir === "string" && dir.trim() !== "") return path.resolve(dir.trim());
  } catch {
    // no settings file, or one pi-live itself will complain about: the default
  }
  return path.join(agentDir(env), "live");
}
