import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { posix, resolve } from "node:path";
import type { Connect } from "vite";

function rejectRemoteCleartextLogin(): Connect.NextHandleFunction {
  return (request, response, next) => {
    let requestPath: string;
    try {
      requestPath = posix.normalize(decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname));
    } catch {
      requestPath = "";
    }
    if (requestPath !== "/api/auth/login") return next();
    const address = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (address === "127.0.0.1" || address === "::1") return next();
    response.statusCode = 403;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: "https_required" }));
  };
}

export default defineConfig({
  root: resolve(import.meta.dirname, "."),
  plugins: [
    react(),
    {
      name: "reject-remote-cleartext-login",
      configureServer(server) {
        server.middlewares.use(rejectRemoteCleartextLogin());
      },
    },
  ],
  resolve: { alias: { "react-native": "react-native-web" } },
  server: {
    host: "0.0.0.0",
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { "/api": { target: `http://127.0.0.1:${process.env.API_PORT ?? 3000}`, ws: true } },
  },
});
