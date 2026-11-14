import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TerminalStore, type CoreSession, type Terminal } from "@herdr-web/core-client";
import { createApp } from "../src/app.js";

function term(address: string, state = "live"): Terminal {
  return { address, argv: ["sh"], cols: 80, rows: 24, created_ms: 1, cwd: "/", state, screen: "exact", labels: {} };
}

let server: Server;
let base: string;
let store: TerminalStore;
let fake: Pick<CoreSession, "store" | "state" | "core" | "lastError">;

beforeEach(async () => {
  store = new TerminalStore();
  fake = { store, state: "connecting", core: null, lastError: null };
  server = createApp(fake as CoreSession).listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => new Promise((r) => server.close(r)));

describe("bridge debug endpoints", () => {
  it("/health reports connection state and seq before and after connecting", async () => {
    expect(await (await fetch(`${base}/health`)).json()).toEqual({ core: null, connection: "connecting", seq: null, error: null });
    store.replaceSnapshot(12, []);
    Object.assign(fake, { state: "connected", core: { info: { id: "abc", name: "box" }, version: "0.1.21" } });
    expect(await (await fetch(`${base}/health`)).json()).toEqual({
      core: { id: "abc", name: "box", version: "0.1.21" },
      connection: "connected",
      seq: 12,
      error: null,
    });
  });

  it("/terminals lists live terminals and machines, hiding finished ones like `hc ls`", async () => {
    store.replaceSnapshot(3, [term("t1"), term("cachyos/t7"), term("t2", "finished")]);
    store.setMachines([{ name: "cachyos", target: "x", id: "i", host: "h", version: "1", state: "connected" }]);
    const body = (await (await fetch(`${base}/terminals`)).json()) as { terminals: Terminal[]; machines: unknown[]; hidden_finished: number; seq: number };
    expect(body.terminals.map((t) => t.address)).toEqual(["t1", "cachyos/t7"]);
    expect(body.hidden_finished).toBe(1);
    expect(body.machines).toHaveLength(1);
    expect(body.seq).toBe(3);
  });

  it("/terminals?all=1 includes finished terminals", async () => {
    store.replaceSnapshot(3, [term("t1"), term("t2", "finished")]);
    const body = (await (await fetch(`${base}/terminals?all=1`)).json()) as { terminals: Terminal[]; hidden_finished: number };
    expect(body.terminals.map((t) => t.address)).toEqual(["t1", "t2"]);
    expect(body.hidden_finished).toBe(0);
  });
});
