import { buildServer } from "./api/server.js";
import { createSublyRuntime } from "./config/runtime.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const host = process.env.HOST ?? "0.0.0.0";

const runtime = await createSublyRuntime(process.env);
const server = buildServer(runtime.service, runtime.serverOptions);
server.log.info({ mode: runtime.mode }, "Subly runtime initialized");

try {
  await server.listen({ port, host });
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
