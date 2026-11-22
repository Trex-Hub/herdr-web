import fs from "node:fs";
import path from "node:path";

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length > 0 && v.length <= max;

/** What pi-live writes to `<sessionId>.json` next to each socket (protocol.md): the parts the backend reads, or why the file is no good. */
function parse(value: unknown): { protocol: unknown; sessionId: string; pid: number; startedAt: string; socketPath: string; mode: unknown; terminal: unknown } | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";
  const v = value as Record<string, unknown>;
  if (!isString(v["sessionId"], 256)) return "sessionId";
  if (typeof v["pid"] !== "number" || !Number.isInteger(v["pid"]) || v["pid"] < 1 || v["pid"] > 2 ** 31) return "pid";
  if (!isString(v["socketPath"], 4096) || !path.isAbsolute(v["socketPath"]) || v["socketPath"].includes("\0")) return "socketPath";
  return { protocol: v["protocol"], sessionId: v["sessionId"], pid: v["pid"], startedAt: typeof v["startedAt"] === "string" ? v["startedAt"].slice(0, 64) : "", socketPath: v["socketPath"], mode: v["mode"], terminal: v["terminal"] };
}

export interface PiSession {
  /** The `.json` file this came from. */
  file: string;
  sessionId: string;
  pid: number;
  socketPath: string;
  /** When pi-live started this session ("" when the file names none). */
  startedAt: string;
  /** Names this file's content: a pi-live that writes the file again (a `/reload` keeps the session id and the path) changes it. */
  key: string;
  /** The terminal pi says it runs in. Only a tui pi with one is of use to the backend; the rest are left out. */
  terminal: string;
}

const MAX_FILE_BYTES = 64 * 1024;
const MAX_FILES = 1000;

/**
 * The session files in pi-live's folder that name a terminal pi in a terminal user interface. Files that are gone by the time they
 * are read, half written or not ours are skipped; a file with the wrong shape is reported once through `invalid`. A missing folder
 * is an empty one.
 */
export function readPiSessions(dir: string, invalid: (file: string, why: string) => void = () => {}): PiSession[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const found: PiSession[] = [];
  for (const name of names.filter((n) => n.endsWith(".json")).slice(0, MAX_FILES)) {
    const file = path.join(dir, name);
    let text: string;
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK); // not blocking: a named pipe in the folder must not stop the backend
      try {
        if (!fs.fstatSync(fd).isFile()) continue;
        const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
        const n = fs.readSync(fd, buffer, 0, buffer.length, 0);
        if (n > MAX_FILE_BYTES) {
          invalid(file, "too big");
          continue;
        }
        text = buffer.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue; // gone, or not readable
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      continue; // not JSON (yet)
    }
    const s = parse(value);
    if (typeof s === "string") {
      invalid(file, s);
      continue;
    }
    if (s.protocol !== undefined && s.protocol !== 1) continue;
    if (name !== `${s.sessionId}.json`) {
      invalid(file, "the name is not the session id");
      continue;
    }
    if (s.mode !== "tui" || !isString(s.terminal, 256)) continue;
    found.push({ file, sessionId: s.sessionId, pid: s.pid, socketPath: s.socketPath, startedAt: s.startedAt, terminal: s.terminal, key: [s.sessionId, s.pid, s.startedAt, s.socketPath].join("|") });
  }
  return found;
}
