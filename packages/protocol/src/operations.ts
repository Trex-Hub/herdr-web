import { z } from "zod";
import { isTerminalAddress } from "./terminal.js";

// --- operations ---------------------------------------------------------------
// The browser changes core only through these named operations, as plain HTTP POSTs with a JSON
// body to the bridge (same cookie and Origin rules as sign-in). See PROTOCOL.md ("Operations").

/** Path prefix of the operations: `POST /api/ops/<name>`. */
export const OPS_PREFIX = "/api/ops/";
/** `GET /api/starters`: what the "+" menu offers. */
export const STARTERS_PATH = "/api/starters";

export const OPERATION_NAMES = ["start", "kill", "seen", "unread", "pin"] as const;
export type OperationName = (typeof OPERATION_NAMES)[number];

export function operationPath(name: OperationName): string {
  return OPS_PREFIX + name;
}

const Address = z.string().refine(isTerminalAddress, "not a terminal address (t7 or machine/t7)");

/** What to start: that machine's shell, `pi`, or one of core's templates by name. */
export const StartWhatSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("shell") }).strict(),
  z.object({ kind: z.literal("pi") }).strict(),
  z.object({ kind: z.literal("template"), name: z.string().min(1).max(64) }).strict(),
]);
export type StartWhat = z.infer<typeof StartWhatSchema>;

export const StartInputSchema = z
  .object({
    /** null: the core the bridge is connected to; otherwise the machine's name there. */
    machine: z.string().min(1).max(64).nullable(),
    /** The space's id as the layout document has it (machine-local). */
    space: z.string().min(1).max(200),
    what: StartWhatSchema,
  })
  .strict();
export type StartInput = z.infer<typeof StartInputSchema>;

export const KillInputSchema = z.object({ terminal: Address }).strict();
export type KillInput = z.infer<typeof KillInputSchema>;

export const SeenInputSchema = z.object({ terminal: Address, turn: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
export type SeenInput = z.infer<typeof SeenInputSchema>;

export const UnreadInputSchema = z.object({ terminal: Address }).strict();
export type UnreadInput = z.infer<typeof UnreadInputSchema>;

export const PinInputSchema = z.object({ terminal: Address, pinned: z.boolean() }).strict();
export type PinInput = z.infer<typeof PinInputSchema>;

export interface StartResult {
  address: string;
}
export interface KillResult {
  address: string;
  /** How it ended, as core reports it: `killed`, `exited`, … */
  reason: string | null;
  exitCode: number | null;
  signal: number | null;
}
export interface SeenResult {
  address: string;
  /** The value of `herdr.seen` now. */
  seen: number;
}
export interface PinResult {
  address: string;
  pinned: boolean;
}

/** Every failure: a sentence the app can show as is. */
export interface OperationError {
  error: string;
}

export const StarterSchema = z.object({
  kind: z.enum(["shell", "pi", "template"]),
  /** What the menu shows; for a template, its name. */
  name: z.string(),
  description: z.string(),
});
export type Starter = z.infer<typeof StarterSchema>;
export const StartersSchema = z.object({ starters: z.array(StarterSchema) });
export type Starters = z.infer<typeof StartersSchema>;

/** The seen label's name, and pinned's: written by operations, read by the app. */
export const SEEN_LABEL = "herdr.seen";
export const PINNED_LABEL = "herdr.pinned";
export const SPACE_LABEL = "herdr.space";
export const TAB_LABEL = "herdr.tab";
