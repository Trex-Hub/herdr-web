// The environment for anything that must talk to the scratch core and never the real one.
// This is the Node twin of scripts/scratch-run and follows the same rules; scripts/test/ checks
// that the two agree. Node code that spawns `hc` or the backend builds its environment here.
import fs from "node:fs"
import path from "node:path"

/** Names that point `hc` at a core. All are removed, so nothing inherited can reach the real one. */
export const REMOVED = ["HC_SOCKET", "HC_SCOPE", "HC_TERMINAL_SOCKET", "HC_TERMINAL_ID", "XDG_RUNTIME_DIR"]

/** @param {NodeJS.ProcessEnv} [env] */
export function scratchRoot(env = process.env) {
  return env.HW_SCRATCH || "/tmp/hw-scratch"
}

/**
 * The absolute scratch root, or an Error when it does not resolve to a path under /tmp. Nothing is
 * created. Symlinks are followed on the part of the path that exists; a '.' or '..' in the part
 * that does not exist yet is refused, because it could climb out after the check.
 * @param {string} root
 * @returns {string}
 */
export function checkRoot(root) {
  let abs = root.startsWith("/") ? root : `${process.cwd()}/${root}`
  abs = abs.replace(/\/+$/, "")
  if (abs === "") throw new Error("the scratch root cannot be /")

  let existing = abs
  let rest = ""
  while (!exists(existing)) {
    const cut = existing.lastIndexOf("/")
    const base = existing.slice(cut + 1)
    existing = cut > 0 ? existing.slice(0, cut) : "/"
    if (base === "" || base === "." || base === "..") {
      throw new Error(`refusing scratch root '${root}': it has '.', '..' or an empty part`)
    }
    rest = `/${base}${rest}`
  }
  let resolved
  try {
    resolved = fs.realpathSync(existing)
  } catch {
    throw new Error(`refusing scratch root '${root}': '${existing}' is not a folder I can resolve`)
  }
  if (resolved === "/") resolved = ""
  resolved += rest
  if (!/^(\/private)?\/tmp\/./.test(resolved)) {
    throw new Error(`refusing scratch root '${root}' (resolves to '${resolved}'): it must be under /tmp`)
  }
  return abs
}

/** @param {string} p */
function exists(p) {
  try {
    fs.lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * `base` with the scratch values set and the core-pointing names removed. Creates the state and
 * config folders. Throws when the root is not under /tmp.
 * @param {string} [root]
 * @param {NodeJS.ProcessEnv} [base]
 * @returns {NodeJS.ProcessEnv}
 */
export function scratchEnv(root = scratchRoot(), base = process.env) {
  const abs = checkRoot(root)
  const state = path.join(abs, "state")
  const config = path.join(abs, "config")
  fs.mkdirSync(state, { recursive: true })
  fs.mkdirSync(config, { recursive: true })
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...base }
  for (const k of REMOVED) delete env[k]
  return { ...env, HC_SESSION: "herdr-web-test", XDG_STATE_HOME: state, XDG_CONFIG_HOME: config }
}
