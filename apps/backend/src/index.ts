import { CoreSession } from "@herdr-web/core-client";
import { AppSharedFile } from "./app-shared.js";
import { ChatHub } from "./chat.js";
import { ConfigError, HOST, loadConfig, type Config } from "./config.js";
import { piLiveDir } from "./pi-live-dir.js";
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

const liveDir = piLiveDir();
const chat = new ChatHub({ session, liveDir, log: (line) => console.log(line) });
await chat.start();
console.log(`chat: watching ${liveDir} for pi-live sessions`);

// herdr-app's groups and names: read, never written.
const appShared = new AppSharedFile({ path: config.appSharedPath });
appShared.start();

const bridge = createBridge({ session, passphrase: config.passphrase, origins: config.origins, buildId: config.buildId, chat, appShared });
// The signal handlers come before the line that says the bridge is up: whoever waits for that line may signal at once.
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await bridge.close();
  appShared.stop();
  await session.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

bridge.server.on("error", (err) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});
await bridge.listen(config.port, HOST).catch((err: Error) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});
console.log(`bridge listening on http://${HOST}:${config.port} (build ${config.buildId}, origins ${config.origins.join(", ")})`);
