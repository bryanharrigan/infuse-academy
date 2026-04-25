// Express entrypoint for AWS Amplify Hosting's SSR compute runtime.
//
// IMPORTANT: we start listening BEFORE attempting to load the Remix build,
// so that any Remix import error is captured in CloudWatch instead of
// silently killing the runtime at parse time. /healthz and /__diag stay up
// regardless so we can probe the live container.

import express from "express";

console.log("[server] startup begin");
console.log("[server] node:", process.version);
console.log("[server] cwd:", process.cwd());
console.log("[server] PORT:", process.env.PORT);

const app = express();
app.disable("x-powered-by");

// Always-on diagnostic routes
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/__diag", (_req, res) => {
  res.json({
    node: process.version,
    cwd: process.cwd(),
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    remixLoaded: Boolean(globalThis.__remixBuild),
    remixError: globalThis.__remixError ?? null,
    remixBuildKeys: globalThis.__remixBuild
      ? Object.keys(globalThis.__remixBuild)
      : null,
  });
});

// Listen first; register Remix handler later if/when build loads.
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});

// Attempt to load Remix asynchronously. Any failure ends up in CloudWatch
// AND visible at /__diag in the live container.
(async () => {
  try {
    console.log("[server] attempting to import ./server/index.js");
    const build = await import("./server/index.js");
    globalThis.__remixBuild = build;
    console.log("[server] build loaded, keys:", Object.keys(build));

    const { createRequestHandler } = await import("@remix-run/express");
    app.all(
      "*",
      createRequestHandler({
        build,
        mode: process.env.NODE_ENV ?? "production",
      })
    );
    console.log("[server] Remix handler registered");
  } catch (err) {
    globalThis.__remixError = {
      name: err?.name,
      message: err?.message,
      stack: err?.stack,
    };
    console.error("[server] FAILED to load Remix build:", err);
    // Catch-all that exposes the error to anyone hitting the app
    app.all("*", (_req, res) => {
      res.status(500).type("text/plain").send(
        "Remix build failed to load. See /__diag for details and CloudWatch for the full stack."
      );
    });
  }
})();
