import { buildServer } from "./api/server.js";
import { createSublyRuntime } from "./config/runtime.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const runtime = await createSublyRuntime(process.env);
const server = buildServer(runtime.service, runtime.serverOptions);
server.log.info({ mode: runtime.mode }, "Subly runtime initialized");

server.addHook("onClose", async () => { await runtime.service.ledger.close?.(); });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    server.log.info({ signal }, "Draining requests and closing the ledger");
    try { await server.close(); } catch (error) { server.log.error(error); process.exitCode = 1; }
  });
}

try {
  await runtime.service.ledger.checkHealth?.();
  await server.listen({ port, host });
} catch (error) {
  server.log.error(error);
  await server.close();
  process.exitCode = 1;
}
