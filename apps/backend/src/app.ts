import type { NextFunction, Request, Response } from "express";
import express, { type Express } from "express";
import type { CoreSession } from "@herdr-web/core-client";
import {
  CHAT_OPERATION_NAMES,
  CHAT_PREFIX,
  ChatEffortInputSchema,
  ChatModelInputSchema,
  ChatOlderInputSchema,
  ChatResultInputSchema,
  ChatSendInputSchema,
  ChatStopInputSchema,
  type ChatOperationName,
  KillInputSchema,
  OPERATION_NAMES,
  OPS_PREFIX,
  PinInputSchema,
  SeenInputSchema,
  STARTERS_PATH,
  StartInputSchema,
  UnreadInputSchema,
  type OperationName,
} from "@herdr-web/protocol";
import { Auth, LoginLimiter, sessionCookie } from "./auth.js";
import type { ChatHub } from "./chat.js";
import { ChatOperations } from "./chat-operations.js";
import { OperationFailure, Operations } from "./operations.js";

export interface AppOptions {
  session: CoreSession;
  auth: Auth;
  limiter: LoginLimiter;
  origins: readonly string[];
  chat: ChatHub;
}

/** Login, a session check, and the debugging endpoints. */
export function createApp({ session, auth, limiter, origins, chat }: AppOptions): Express {
  const app = express();
  app.disable("x-powered-by");
  // The bridge listens on loopback only, so anything forwarded comes from our own proxy
  // (`tailscale serve`): believe it about the scheme, so the cookie gets `Secure` over HTTPS.
  app.set("trust proxy", "loopback");

  // CORS: allowed origins may use credentials; others get no headers, so a browser keeps them out.
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.vary("Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("Access-Control-Allow-Methods", "GET, POST");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");
        res.setHeader("Access-Control-Max-Age", "600");
      }
    }
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  // A request that changes anything must come from an allowed origin, or from no browser at all.
  app.use((req, res, next) => {
    if (req.method === "POST" && req.headers.origin && !origins.includes(req.headers.origin)) {
      res.status(403).json({ error: "origin not allowed" });
      return;
    }
    next();
  });

  // Renew the cookie on every use.
  app.use((req, res, next) => {
    if (auth.isSignedIn(req)) {
      res.locals["signedIn"] = true;
      res.setHeader("Set-Cookie", sessionCookie(auth.issueToken(), req.secure));
    }
    next();
  });

  const requireSignIn = (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals["signedIn"]) next();
    else res.status(401).json({ error: "sign in required" });
  };

  app.get("/health", (_req, res) => {
    const { state, error, core } = session.connection;
    // The error text names core's socket path and the OS error: only for a signed-in caller.
    res.json({ core, connection: state, seq: session.store.seq, ...(res.locals["signedIn"] && { error }) });
  });

  app.get("/api/session", (_req, res) => {
    res.json({ signedIn: res.locals["signedIn"] === true });
  });

  app.post("/api/login", express.json({ limit: "2kb" }), (req, res) => {
    const wait = limiter.waitMs();
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      res.setHeader("Retry-After", String(seconds));
      res.status(429).json({ error: "too many attempts", retryAfterSeconds: seconds });
      return;
    }
    const passphrase = (req.body as { passphrase?: unknown } | undefined)?.passphrase;
    if (typeof passphrase !== "string") {
      res.status(400).json({ error: "expected a JSON body with a passphrase" });
      return;
    }
    if (!auth.checkPassphrase(passphrase)) {
      limiter.failure();
      res.status(401).json({ error: "wrong passphrase" });
      return;
    }
    limiter.success();
    res.setHeader("Set-Cookie", sessionCookie(auth.issueToken(), req.secure));
    res.json({ signedIn: true });
  });

  app.post("/api/logout", (req, res) => {
    res.setHeader("Set-Cookie", sessionCookie(null, req.secure));
    res.json({ signedIn: false });
  });

  // Like `hc ls`: live terminals only; `?all=1` includes finished ones (like `hc ls --all`).
  app.get("/terminals", requireSignIn, (req, res) => {
    const all = req.query["all"] === "1" || req.query["all"] === "true";
    const everything = session.store.list();
    const terminals = all ? everything : everything.filter((t) => t.state !== "finished");
    res.json({
      connection: session.state,
      seq: session.store.seq,
      hidden_finished: everything.length - terminals.length,
      terminals,
      machines: session.store.machines,
    });
  });

  // The operations that change core. Each needs the cookie (and, from a browser, an allowed Origin: see above).
  const operations = new Operations(session);
  const chatOperations = new ChatOperations(session, chat);
  interface Parser {
    safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } };
  }
  type Table = Record<string, { schema: Parser; run: (input: never) => Promise<unknown> }>;
  const inputs: Record<OperationName, Table[string]> = {
    start: { schema: StartInputSchema, run: (i) => operations.start(i) },
    kill: { schema: KillInputSchema, run: (i) => operations.kill(i) },
    seen: { schema: SeenInputSchema, run: (i) => operations.seen(i) },
    unread: { schema: UnreadInputSchema, run: (i) => operations.unread(i) },
    pin: { schema: PinInputSchema, run: (i) => operations.pin(i) },
  };
  const chatInputs: Record<ChatOperationName, Table[string]> = {
    send: { schema: ChatSendInputSchema, run: (i) => chatOperations.send(i) },
    stop: { schema: ChatStopInputSchema, run: (i) => chatOperations.stop(i) },
    model: { schema: ChatModelInputSchema, run: (i) => chatOperations.model(i) },
    effort: { schema: ChatEffortInputSchema, run: (i) => chatOperations.effort(i) },
    older: { schema: ChatOlderInputSchema, run: (i) => chatOperations.older(i) },
    result: { schema: ChatResultInputSchema, run: (i) => chatOperations.result(i) },
  };
  const fail = (res: Response, err: unknown) => {
    if (err instanceof OperationFailure) res.status(err.status).json({ error: err.message });
    else res.status(500).json({ error: "internal error" });
  };

  /** `POST <prefix><name>`: the cookie, a JSON body checked against the operation's schema, then the operation. */
  const post = (prefix: string, names: readonly string[], table: Table, limit: string) =>
    app.post(`${prefix}:name`, requireSignIn, express.json({ limit }), (req, res) => {
      const name = String(req.params["name"]);
      const op = names.includes(name) ? table[name] : undefined;
      if (!op) {
        res.status(404).json({ error: `There is no operation called ${name}.` });
        return;
      }
      const parsed = op.schema.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        res.status(400).json({ error: `Bad request: ${issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid input"}.` });
        return;
      }
      op.run(parsed.data as never).then((result) => res.json(result), (err: unknown) => fail(res, err));
    });
  post(OPS_PREFIX, OPERATION_NAMES, inputs, "4kb");
  post(CHAT_PREFIX, CHAT_OPERATION_NAMES, chatInputs, "1mb");

  app.get(STARTERS_PATH, requireSignIn, (_req, res) => {
    operations.starters().then((starters) => res.json({ starters }), (err: unknown) => fail(res, err));
  });

  // Malformed JSON and the like: a plain 400, not a stack trace.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
