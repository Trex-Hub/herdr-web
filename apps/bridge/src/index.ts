import { CoreSession } from "@herdr-web/core-client";
import { createApp } from "./app.js";

const HOST = "127.0.0.1";
const rawPort = process.env["PORT"];
const port = rawPort === undefined || rawPort === "" ? 7420 : Number(rawPort); // empty counts as unset
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`bridge: invalid PORT ${JSON.stringify(process.env["PORT"])}`);
  process.exit(1);
}

const session = new CoreSession({
  log: (level, message) => (level === "warn" ? console.warn : console.log)(`[core] ${message}`),
});
session.start();

const server = createApp(session).listen(port, HOST, () => {
  console.log(`bridge listening on http://${HOST}:${port}`);
});
server.on("error", (err) => {
  console.error(`bridge: ${err.message}`);
  process.exit(1);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  server.closeAllConnections();
  await session.stop();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
