import type { NextFunction, Request, Response } from "express";
import express, { type Express } from "express";
import type { CoreSession } from "@herdr-web/core-client";
import { Auth, LoginLimiter, sessionCookie } from "./auth.js";

export interface AppOptions {
  session: CoreSession;
  auth: Auth;
  limiter: LoginLimiter;
  origins: readonly string[];
}

/** Login, a session check, and the debugging endpoints. */
export function createApp({ session, auth, limiter, origins }: AppOptions): Express {
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
    res.json({ core, connection: state, seq: session.store.seq, error });
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

  // Malformed JSON and the like: a plain 400, not a stack trace.
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500;
    res.status(status).json({ error: status === 500 ? "internal error" : "bad request" });
  });

  return app;
}
