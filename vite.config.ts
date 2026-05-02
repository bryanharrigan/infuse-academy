import { vitePlugin as remix } from "@remix-run/dev";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import fs from "node:fs";
import path from "node:path";

const certPath = path.resolve(__dirname, "certs/cert.pem");
const keyPath = path.resolve(__dirname, "certs/key.pem");
const hasCerts = fs.existsSync(certPath) && fs.existsSync(keyPath);

export default defineConfig({
  // Force MUI + Emotion to be bundled into the SSR output (build/server/index.js)
  // instead of being imported from node_modules at runtime. Required for
  // production deploy on Node ESM runtimes (Amplify Hosting compute, Lambda,
  // etc.) because MUI's published ESM uses directory imports without explicit
  // /index.js, which Node's strict resolver rejects with ERR_UNSUPPORTED_DIR_IMPORT.
  // This is the Vite-equivalent of the old `serverDependenciesToBundle` option
  // that the Remix Compiler used (and which the Remix Vite plugin silently ignores).
  ssr: {
    noExternal: [/^@mui\//, /^@emotion\//],
  },
  /**
   * MUI v5 ships parallel build trees inside @mui/system and
   * @mui/icons-material:
   *   - CJS files at the package root  (e.g. .../createStyled.js)
   *   - ESM files under /esm/          (e.g. .../esm/createStyled.js)
   *
   * Their package.json has no `exports` map, so any subpath import like
   * `@mui/system/createStyled` resolves to the CJS file. Vite's SSR
   * module runner then evaluates that CJS file as ESM and crashes with
   * `ReferenceError: require is not defined` at line 5.
   *
   * Workaround: rewrite every subpath import on these two packages to
   * the /esm/ variant. We exclude `esm/` itself so we don't double-prefix.
   * `@mui/material` already handles this via its own per-subdir
   * package.json files (where `main` points to ../node/* CJS and `module`
   * points to the ESM at the normal path), so we leave it alone.
   *
   * Applies to dev + build — the ESM files are what should be bundled in
   * production anyway, so this keeps both code paths consistent.
   */
  resolve: {
    alias: [
      {
        find: /^@mui\/system\/(?!esm\/)(.+)$/,
        replacement: "@mui/system/esm/$1",
      },
      {
        find: /^@mui\/icons-material\/(?!esm\/)(.+)$/,
        replacement: "@mui/icons-material/esm/$1",
      },
    ],
  },
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
      // NOTE: `serverDependenciesToBundle` was a Remix Compiler option and is
      // silently ignored by the Vite plugin. SSR bundling is now configured
      // via top-level `ssr.noExternal` above.
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
      },
    }),
    tsconfigPaths(),
  ],
});
