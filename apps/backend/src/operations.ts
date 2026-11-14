import { randomBytes } from "node:crypto";
import {
  ConnectionClosedError,
  CoreError,
  type CoreSession,
  type SpaceLayout,
  type Terminal,
} from "@herdr-web/core-client";
import {
  PINNED_LABEL,
  SEEN_LABEL,
  SPACE_LABEL,
  TAB_LABEL,
  type KillInput,
  type KillResult,
  type PinInput,
  type PinResult,
  type SeenInput,
  type SeenResult,
  type StartInput,
  type StartResult,
  type Starter,
  type UnreadInput,
} from "@herdr-web/protocol";

/** A refusal or failure: an HTTP status and a sentence the app shows as is. */
export class OperationFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const refuse = (status: number, message: string): never => {
  throw new OperationFailure(status, message);
};

/** Core's own words, passed on; its hint (when it has one) follows. */
function describe(err: unknown): string {
  if (err instanceof OperationFailure) return err.message;
  if (err instanceof CoreError) return err.hint ? `${err.message} (${err.hint})` : err.message;
  if (err instanceof ConnectionClosedError) return "The bridge is not connected to core right now.";
  return err instanceof Error ? err.message : String(err);
}

/** `herdr.seen` as a number, or null when missing or not a number. */
function seenOf(t: Terminal): number | null {
  const raw = t.labels?.[SEEN_LABEL];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

export const STARTERS_BASE: Starter[] = [
  { kind: "shell", name: "Shell", description: "The machine's own shell" },
  { kind: "pi", name: "pi", description: "The pi coding agent" },
];

/**
 * The five things the browser may do to core, and nothing else. Every method checks its input
 * against the bridge's own copy of the terminals and layouts first: a refusal makes no core call
 * (a template name is the one input checked against core itself, with a read).
 */
export class Operations {
  constructor(private readonly session: CoreSession) {}

  private async core<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      throw new OperationFailure(err instanceof ConnectionClosedError ? 503 : 502, describe(err));
    }
  }

  private live(address: string): Terminal {
    const t = this.session.store.get(address);
    if (!t) return refuse(404, `No terminal ${address}.`);
    if (t.state !== "live") return refuse(409, `${address} has ended.`);
    return t;
  }

  async starters(): Promise<Starter[]> {
    const { templates } = await this.core(() => this.session.call("templates.list", {}));
    return [
      ...STARTERS_BASE,
      ...templates.filter((t) => !t.error).map((t): Starter => ({ kind: "template", name: t.name, description: t.description })),
    ];
  }

  async start(input: StartInput): Promise<StartResult> {
    const { machine, space: spaceId, what } = input;
    const layout = this.session.layouts.get(machine);
    const where = machine ?? "this computer";
    if (machine !== null && !this.session.store.machines.some((m) => m.name === machine)) refuse(404, `No machine called ${machine}.`);
    if (!layout || layout.status !== "ok") refuse(409, `The layout of ${where} cannot be read right now${layout?.reason ? `: ${layout.reason}` : ""}.`);
    const space: SpaceLayout | undefined = layout!.spaces.find((s) => s.id === spaceId);
    if (!space) return refuse(404, `${where} has no space with that id.`);

    let argv: string[] | undefined;
    if (what.kind === "pi") argv = ["pi"];
    if (what.kind === "template") {
      const { templates } = await this.core(() => this.session.call("templates.list", {}));
      const template = templates.find((t) => t.name === what.name);
      if (!template) return refuse(404, `Core has no template called ${what.name}.`);
      if (template.error) return refuse(409, `The template ${what.name} cannot be used: ${template.error}`);
      argv = [what.name];
    }

    const run = await this.core(() =>
      this.session.call("terminal.run", {
        ...(argv && { argv }),
        ...(space.folder && { cwd: space.folder }),
        ...(machine !== null && { on: machine }),
        keep: true,
        no_parent: true,
        labels: { [SPACE_LABEL]: space.id, [TAB_LABEL]: `tb${randomBytes(16).toString("hex")}`, [SEEN_LABEL]: "0" },
      }),
    );
    // Core answers `t7`; an added machine's terminal is `machine/t7` everywhere else.
    const address = machine !== null && !run.address.includes("/") ? `${machine}/${run.address}` : run.address;
    return { address };
  }

  async kill(input: KillInput): Promise<KillResult> {
    this.live(input.terminal);
    // A killed terminal stays finished across a core restart even when it was started with keep (checked on core 0.1.21).
    const t = await this.core(() => this.session.call("terminal.kill", { terminal: input.terminal }));
    return { address: input.terminal, reason: t.reason ?? null, exitCode: t.exit_code ?? null, signal: t.signal ?? null };
  }

  private async writeSeen(address: string, turn: number): Promise<SeenResult> {
    await this.core(() => this.session.call("terminal.label", { terminal: address, labels: { [SEEN_LABEL]: String(turn) } }));
    return { address, seen: turn };
  }

  async seen(input: SeenInput): Promise<SeenResult> {
    const t = this.live(input.terminal);
    const turn = t.turn ?? 0;
    if (input.turn > turn) refuse(409, `${input.terminal} is only at turn ${turn}; it cannot be marked seen at ${input.turn}.`);
    const current = seenOf(t);
    if (current !== null && input.turn <= current) refuse(409, `${input.terminal} is already marked seen at ${current}.`);
    return this.writeSeen(input.terminal, input.turn);
  }

  async unread(input: UnreadInput): Promise<SeenResult> {
    const t = this.live(input.terminal);
    const turn = t.turn ?? 0;
    if (turn === 0) refuse(409, `${input.terminal} has not finished a turn yet, so there is nothing to mark unread.`);
    return this.writeSeen(input.terminal, turn - 1);
  }

  async pin(input: PinInput): Promise<PinResult> {
    this.live(input.terminal);
    await this.core(() => this.session.call("terminal.label", { terminal: input.terminal, labels: { [PINNED_LABEL]: input.pinned ? "1" : "" } }));
    return { address: input.terminal, pinned: input.pinned };
  }
}
