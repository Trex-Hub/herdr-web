import { afterEach, describe, expect, it } from "vitest";
import { CoreTimeoutError, ConnectionClosedError } from "../src/errors.js";
import { CoreSession } from "../src/session.js";
import { FakeCore } from "./fake-core.js";

const cores: FakeCore[] = [];
const sessions: CoreSession[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) await s.stop();
  for (const c of cores.splice(0)) await c.dispose();
});

async function setup(callTimeoutMs?: number) {
  const core = new FakeCore();
  cores.push(core);
  await core.listen();
  const session = new CoreSession({ endpoint: () => core.path, ...(callTimeoutMs !== undefined && { callTimeoutMs }) });
  sessions.push(session);
  session.start();
  const end = Date.now() + 2000;
  while (session.state !== "connected") {
    if (Date.now() > end) throw new Error("not connected");
    await new Promise((r) => setTimeout(r, 5));
  }
  return { core, session };
}

describe("a time limit on calls", () => {
  it("a call core does not answer rejects with CoreTimeoutError after the limit, naming the method", async () => {
    const { core, session } = await setup(150);
    core.muted = true;
    const began = Date.now();
    const error = await session.call("terminal.kill", { terminal: "t1" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CoreTimeoutError);
    expect((error as CoreTimeoutError).message).toMatch(/^Core did not answer \(terminal\.kill/);
    expect(Date.now() - began).toBeGreaterThanOrEqual(140);
    expect(Date.now() - began).toBeLessThan(1500);
  });

  it("the connection stays up and the next call works once core answers again; the late reply to the first is dropped", async () => {
    const { core, session } = await setup(150);
    core.rpc.set("terminal.kill", () => ({ address: "t1", state: "finished" }) as never);
    core.muted = true;
    await expect(session.call("terminal.kill", { terminal: "t1" })).rejects.toBeInstanceOf(CoreTimeoutError);
    core.muted = false;
    expect(session.state).toBe("connected");
    await expect(session.call("terminal.kill", { terminal: "t1" })).resolves.toMatchObject({ address: "t1" });
  });

  it("an answer in time clears the timer: nothing rejects later", async () => {
    const { core, session } = await setup(100);
    core.rpc.set("terminal.kill", () => ({ address: "t1", state: "finished" }) as never);
    await expect(session.call("terminal.kill", { terminal: "t1" })).resolves.toBeDefined();
    await new Promise((r) => setTimeout(r, 250));
    expect(session.state).toBe("connected");
  });

  it("the default limit is 10 s", async () => {
    const { CALL_TIMEOUT_MS } = await import("../src/session.js");
    expect(CALL_TIMEOUT_MS).toBe(10_000);
  });

  it("not connected is still ConnectionClosedError, not a timeout", async () => {
    const session = new CoreSession({ endpoint: () => "/tmp/hw-no-such-core.sock", callTimeoutMs: 50 });
    sessions.push(session);
    await expect(session.call("terminal.kill", { terminal: "t1" })).rejects.toBeInstanceOf(ConnectionClosedError);
  });
});
