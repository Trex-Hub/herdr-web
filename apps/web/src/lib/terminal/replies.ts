/**
 * Telling the terminal's own answers from a person typing.
 *
 * xterm.js reports everything through one `onData`: a key, a paste, and also the reply to a
 * device query the program sent (`CSI c`, `CSI ? u`, colour queries, …). Core wants the replies
 * as AUTOMATIC_INPUT so they do not count as someone being at the keyboard, and it says: tag
 * them where they are produced, never by looking at their bytes.
 *
 * Where they are produced is inside the parser, while it executes the query. So for every
 * sequence that can make xterm answer, we register a handler that only raises a flag and
 * declines (returns false), letting xterm's own handler run next and call `onData` on the same
 * call stack. A real key can never arrive inside that stack, and the flag drops before the
 * next task, so `isAutomatic()` is true exactly for the data xterm produced by itself.
 */

/** The parser surface used here; both `Terminal` and the headless one have it. */
export interface ParserHost {
  parser: {
    registerCsiHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (params: (number | number[])[]) => boolean | Promise<boolean>): { dispose(): void };
    registerDcsHandler(id: { prefix?: string; intermediates?: string; final: string }, cb: (data: string, params: (number | number[])[]) => boolean | Promise<boolean>): { dispose(): void };
    registerOscHandler(ident: number, cb: (data: string) => boolean | Promise<boolean>): { dispose(): void };
  };
  write(data: string | Uint8Array, callback?: () => void): void;
}

export interface ReplyTagging {
  /** True while xterm is producing an answer of its own: call from inside `onData`. */
  isAutomatic(): boolean;
  dispose(): void;
}

/** CSI sequences xterm answers: device attributes, status reports, window reports, kitty keyboard query/flags, DECRQM, XTVERSION, DECREQTPARM. */
const CSI: Array<{ prefix?: string; intermediates?: string; final: string }> = [
  { final: "c" },
  { prefix: ">", final: "c" },
  { prefix: "=", final: "c" },
  { final: "n" },
  { prefix: "?", final: "n" },
  { final: "t" },
  { final: "x" },
  { prefix: "?", final: "u" },
  { prefix: "=", final: "u" },
  { prefix: ">", final: "u" },
  { prefix: "<", final: "u" },
  { prefix: ">", final: "q" },
  { intermediates: "$", final: "p" },
  { prefix: "?", intermediates: "$", final: "p" },
];

/** OSC sequences xterm answers: colour queries (palette, foreground, background, cursor). */
const OSC = [4, 10, 11, 12, 17, 19];

/** DCS sequences xterm answers: DECRQSS, and XTGETTCAP (which it leaves unanswered). */
const DCS: Array<{ prefix?: string; intermediates?: string; final: string }> = [
  { intermediates: "$", final: "q" },
  { intermediates: "+", final: "q" },
];

export function tagReplies(term: ParserHost): ReplyTagging {
  let automatic = false;
  const raise = (): false => {
    automatic = true;
    queueMicrotask(() => (automatic = false));
    return false; // decline: xterm's own handler runs next and produces the reply
  };
  const disposers = [
    ...CSI.map((id) => term.parser.registerCsiHandler(id, raise)),
    ...OSC.map((n) => term.parser.registerOscHandler(n, raise)),
    ...DCS.map((id) => term.parser.registerDcsHandler(id, raise)),
  ];
  return {
    isAutomatic: () => automatic,
    dispose: () => disposers.forEach((d) => d.dispose()),
  };
}

/**
 * Stop xterm from sending its own focus reports (`ESC [ I` / `ESC [ O`). The terminal socket
 * tells core about focus with a FOCUS frame, and core re-injects the reports only for programs
 * that asked (DECSET 1004). So 1004 is taken out of every `CSI ? … h`, and xterm never turns
 * its own reporting on.
 */
export function suppressFocusReports(term: ParserHost): { dispose(): void } {
  return term.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
    const flat = params.flat();
    if (!flat.includes(1004)) return false;
    const rest = flat.filter((p) => p !== 1004);
    if (rest.length > 0) term.write(`\x1b[?${rest.join(";")}h`);
    return true;
  });
}
