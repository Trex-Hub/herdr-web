import { agentsSocketPath } from "@herdr-web/agents";
import { CoreSession } from "@herdr-web/core-client";
import { ChatHub } from "./chat.js";
import { ConfigError, HOST, loadConfig, type Config } from "./config.js";
import { createBridge } from "./server.js";

let config: Config;
try {
  config = loadConfig();
} catch (err) {
  if (!(err instanceof ConfigError)) throw err;
  for (const problem of err.problems) console.error(`bridge: ${problem}`);
  process.exit(1);
}

const session = new CoreSession({
  log: (level, message) => (level === "warn" ? console.warn : console.log)(`[core] ${message}`),
});
session.start();

const chat = new ChatHub({ session, socketPath: agentsSocketPath(), log: (line) => console.log(line) });
await chat.start();

const bridge = createBridge({ session, passphrase: config.passphrase, origins: config.origins, buildId: config.buildId, chat });
bridge.server.on("error", (err) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});
await bridge.listen(config.port, HOST).catch((err: Error) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});
console.log(`bridge listening on http://${HOST}:${config.port} (build ${config.buildId}, origins ${config.origins.join(", ")})`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.close();
  await session.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
