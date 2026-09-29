import { app } from "../src/app";

const port = Number(process.env.API_PORT);
if (process.env.DATABASE_PATH !== "/var/lib/remotecode/remotecode.sqlite" || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("Expected the isolated storage-proof database and API port");
}

const server = app.listen({ hostname: "127.0.0.1", port });
console.log(`Storage-proof API process ${process.pid} listening on ${port}`);

process.once("SIGTERM", () => {
  void server.stop(true).then(
    () => process.exit(0),
    (error) => {
      console.error("Storage-proof API shutdown failed", error);
      process.exit(1);
    },
  );
});
