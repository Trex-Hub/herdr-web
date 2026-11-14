import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface EndpointEnv {
  HC_SOCKET?: string | undefined;
  HC_SESSION?: string | undefined;
  XDG_RUNTIME_DIR?: string | undefined;
  XDG_STATE_HOME?: string | undefined;
  HOME?: string | undefined;
}

export interface EndpointOptions {
  env?: EndpointEnv;
  uid?: number;
  home?: string;
  exists?: (p: string) => boolean;
}

export function sessionName(env: EndpointEnv = process.env): string {
  return env.HC_SESSION || "default";
}

/**
 * Where core's client socket may be, most specific first:
 * HC_SOCKET, `$XDG_RUNTIME_DIR/herdr-core/<session>.sock`,
 * `/run/user/<uid>/herdr-core/<session>.sock`, then the state directory
 * (`$XDG_STATE_HOME` or `~/.local/state`) `/herdr-core/<session>/<session>.sock`.
 */
export function endpointCandidates(opts: EndpointOptions = {}): string[] {
  const env = opts.env ?? process.env;
  if (env.HC_SOCKET) return [env.HC_SOCKET];
  const session = sessionName(env);
  const uid = opts.uid ?? process.getuid?.() ?? 0;
  const home = opts.home ?? env.HOME ?? homedir();
  const candidates: string[] = [];
  if (env.XDG_RUNTIME_DIR) {
    candidates.push(path.join(env.XDG_RUNTIME_DIR, "herdr-core", `${session}.sock`));
  }
  candidates.push(path.join("/run/user", String(uid), "herdr-core", `${session}.sock`));
  const stateHome = env.XDG_STATE_HOME || path.join(home, ".local", "state");
  candidates.push(path.join(stateHome, "herdr-core", session, `${session}.sock`));
  return candidates;
}

/** First candidate whose socket file exists; the last one (state dir) when none does. */
export function resolveEndpoint(opts: EndpointOptions = {}): string {
  const exists = opts.exists ?? existsSync;
  const candidates = endpointCandidates(opts);
  return candidates.find((c) => exists(c)) ?? candidates[candidates.length - 1]!;
}
