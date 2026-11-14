import express, { type Express } from "express";
import type { CoreSession } from "@herdr-web/core-client";

/**
 * Debugging surface over the live terminal list. Not the browser protocol.
 */
export function createApp(session: CoreSession): Express {
  const app = express();
  app.disable("x-powered-by");

  app.get("/health", (_req, res) => {
    res.json({
      core: session.core && { name: session.core.info.name, id: session.core.info.id, version: session.core.version },
      connection: session.state,
      seq: session.store.seq,
      error: session.lastError,
    });
  });

  // Like `hc ls`: live terminals only; `?all=1` includes finished ones (like `hc ls --all`).
  app.get("/terminals", (req, res) => {
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

  return app;
}
