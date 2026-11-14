import { createHash, createHmac, scryptSync, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const COOKIE_NAME = "herdr_web_session";
export const COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Clock = () => number;

/**
 * Stateless sign-in. A cookie is an expiry time signed with a key derived from the
 * passphrase, so changing the passphrase invalidates every cookie, and the bridge keeps
 * no list of sessions.
 */
export class Auth {
  private readonly key: Buffer;
  private readonly passphraseDigest: Buffer;

  constructor(
    passphrase: string,
    private readonly now: Clock = Date.now,
  ) {
    // scrypt makes guessing a weak passphrase from a stolen cookie slow. The salt is fixed
    // so that restarting the bridge does not sign everyone out.
    this.key = scryptSync(passphrase, "herdr-web cookie key v1", 32);
    this.passphraseDigest = createHash("sha256").update(passphrase).digest();
  }

  checkPassphrase(candidate: string): boolean {
    return timingSafeEqual(createHash("sha256").update(candidate).digest(), this.passphraseDigest);
  }

  /** A fresh cookie value, valid for 30 days from now. */
  issueToken(): string {
    const exp = String(this.now() + COOKIE_MAX_AGE_MS);
    return `${exp}.${this.sign(exp)}`;
  }

  verifyToken(token: string | undefined): boolean {
    if (!token) return false;
    const dot = token.indexOf(".");
    if (dot < 1) return false;
    const exp = token.slice(0, dot);
    const given = Buffer.from(token.slice(dot + 1));
    const expected = Buffer.from(this.sign(exp));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    return /^\d+$/.test(exp) && Number(exp) > this.now();
  }

  /** Whether the request carries a valid session cookie. */
  isSignedIn(req: IncomingMessage): boolean {
    return this.verifyToken(readCookie(req.headers.cookie, COOKIE_NAME));
  }

  private sign(exp: string): string {
    return createHmac("sha256", this.key).update(`session.${exp}`).digest("base64url");
  }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/** The Set-Cookie value that signs a device in (renewing it) or, with `token` null, signs it out. */
export function sessionCookie(token: string | null, secure: boolean): string {
  const parts = [`${COOKIE_NAME}=${token ?? ""}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (token === null) parts.push("Max-Age=0", "Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  else parts.push(`Max-Age=${COOKIE_MAX_AGE_MS / 1000}`);
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export interface LimiterOptions {
  /** Failures allowed before the first delay. */
  freeFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Failures are forgotten after this long without one. */
  forgetAfterMs?: number;
}

/**
 * Slows down wrong passphrases. One counter for the whole bridge: there is one user, and
 * behind a proxy every request comes from the same address. After `freeFailures` wrong
 * passphrases in a row each further failure doubles the wait (1 s, 2 s, 4 s ... up to
 * `maxDelayMs`), during which every attempt is refused, the right passphrase included.
 */
export class LoginLimiter {
  private failures = 0;
  private lastFailure = 0;
  private lockedUntil = 0;
  private readonly opts: Required<LimiterOptions>;

  constructor(
    private readonly now: Clock = Date.now,
    opts: LimiterOptions = {},
  ) {
    this.opts = { freeFailures: 5, baseDelayMs: 1000, maxDelayMs: 15 * 60 * 1000, forgetAfterMs: 60 * 60 * 1000, ...opts };
  }

  /** Milliseconds to wait before an attempt is accepted; 0 when it may go ahead. */
  waitMs(): number {
    this.forgetOldFailures();
    return Math.max(0, this.lockedUntil - this.now());
  }

  failure(): void {
    this.forgetOldFailures();
    this.failures += 1;
    this.lastFailure = this.now();
    const over = this.failures - this.opts.freeFailures;
    if (over >= 0) this.lockedUntil = this.now() + Math.min(this.opts.baseDelayMs * 2 ** over, this.opts.maxDelayMs);
  }

  success(): void {
    this.failures = 0;
    this.lockedUntil = 0;
  }

  private forgetOldFailures(): void {
    if (this.failures > 0 && this.now() - this.lastFailure > this.opts.forgetAfterMs) this.success();
  }
}
