import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HOST = "127.0.0.1";

export interface Config {
  port: number;
  passphrase: string;
  /** Web origins allowed to call the bridge and open its sockets, as `scheme://host[:port]`. */
  origins: string[];
  /** Sent in `hello`; a browser holding another build is told to reload. */
  buildId: string;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
  }
}

/** An empty variable counts as unset. */
function value(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = env[name];
  return v === undefined || v === "" ? undefined : v;
}

/** Read the settings from the environment; throws a ConfigError naming every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const rawPort = value(env, "PORT");
  const port = rawPort === undefined ? 7420 : Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`invalid PORT ${JSON.stringify(env["PORT"])}`);

  const passphrase = value(env, "HERDR_WEB_PASSPHRASE");
  if (passphrase === undefined) problems.push("HERDR_WEB_PASSPHRASE is not set: the bridge will not start without a passphrase");

  const origins: string[] = [];
  for (const raw of (value(env, "HERDR_WEB_ORIGINS") ?? "http://localhost:3000").split(",")) {
    const o = raw.trim().replace(/\/+$/, "");
    if (o === "") continue;
    let normalized: string | null = null;
    try {
      const url = new URL(o);
      normalized = url.origin === "null" || url.origin !== o ? null : url.origin;
    } catch {
      // reported below
    }
    if (normalized === null) problems.push(`HERDR_WEB_ORIGINS: ${JSON.stringify(o)} is not an origin (expected scheme://host[:port])`);
    else origins.push(normalized);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { port, passphrase: passphrase!, origins, buildId: value(env, "HERDR_WEB_BUILD_ID") ?? gitBuildId() ?? "dev" };
}

function gitBuildId(): string | null {
  try {
    const cwd = path.dirname(fileURLToPath(import.meta.url));
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || null;
  } catch {
    return null;
  }
}
