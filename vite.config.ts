import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";

const certPath = path.resolve(__dirname, "certs/cert.pem");
const keyPath = path.resolve(__dirname, "certs/key.pem");
const hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
  server: {
    host: "0.0.0.0",
    allowedHosts: ["infuse.bryanharrigan.dev"],
    port: 5173,
    // Force HTTP/1.1-only HTTPS server. Vite's default when you pass
    // `server.https` is http2.createSecureServer({ allowHTTP1: true }), which
    // lets Chrome negotiate HTTP/2 — that crashes Remix 2.10's node-adapter
    // because its fromNodeRequest can't translate HTTP/2 pseudo-headers
    // (":method", ":path", ":authority") into a Web Headers object.
    // Setting `proxy` to any object makes Vite's resolveHttpServer take the
    // HTTP/1.1 path (https.createServer) instead. See:
    //   https://github.com/vitejs/vite/blob/v5/packages/vite/src/node/http.ts
    proxy: {},
    ...(hasCerts && {
      https: {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
    }),
  },
  plugins: [
    /**
     * Remix 2.10's Vite node-adapter crashes with
     *   Headers.set: ":method" is an invalid header name
     * whenever incoming req.headers contains HTTP/2 pseudo-headers
     * (":method", ":path", ":scheme", ":authority"). That happens when the
     * browser negotiates HTTP/2 against Vite's HTTPS server. Stripping
     * them here is a harmless, compatible workaround — Remix derives the
     * request method and URL from `req.method` / `req.url` anyway.
     */
    {
      name: "strip-h2-pseudo-headers",
      configureServer(server) {
        server.middlewares.use((req, _res, next) => {
          if (req.headers) {
            for (const k of Object.keys(req.headers)) {
              if (k.startsWith(":")) delete req.headers[k];
            }
          }
          next();
        });
      },
    },
    remix({
      serverDependenciesToBundle: [/^@mui\//, /^@emotion\//],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
});
