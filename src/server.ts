import { createApi } from "./api.js";
import { openBucketeer } from "./core/index.js";

const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("PORT must be an integer between 0 and 65535.");
const core = openBucketeer(process.env.DATABASE_PATH ?? "data/bucketeer.sqlite");
const server = createApi(core);

server.on("error", (error) => {
  core.close();
  console.error(error.message);
  process.exitCode = 1;
});
server.listen(port, process.env.HOST ?? "0.0.0.0", () => {
  const address = server.address();
  console.log(`Bucketeer listening on port ${typeof address === "object" && address ? address.port : port}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => core.close());
    server.closeIdleConnections();
  });
}
