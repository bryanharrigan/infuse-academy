// Express entrypoint for AWS Amplify Hosting's SSR compute runtime.
//
// IMPORTANT: We use top-level await to load the Remix build during Lambda's
// INIT phase (not in a background IIFE). Background async work in Lambda is
// suspended between invocations, so a deferred import may never resolve.
// Init phase has its own timeout (~10s default) but always runs to completion
// before requests are served.
//
// All errors are caught and logged to stderr → CloudWatch, plus surfaced via
// the /__diag route so we can probe the live container.

import express from "express";

console.log("[server] init: starting");
console.log("[server] init: node", process.version, "cwd", process.cwd());

let build = null;
let buildErr = null;
let createRequestHandler = null;
let handlerErr = null;

const t0 = Date.now();
try {
  console.log("[server] init: importing ./server/index.js");
  build = await import("./server/index.js");
  console.log(
    `[server] init: build loaded in ${Date.now() - t0}ms, keys:`,
    Object.keys(build)
  );
} catch (err) {
  buildErr = err;
  console.error("[server] init: BUILD LOAD FAILED:", err && err.stack);
}

const t1 = Date.now();
try {
  console.log("[server] init: importing @remix-run/express");
  ({ createRequestHandler } = await import("@remix-run/express"));
  console.log(
    `[server] init: @remix-run/express loaded in ${Date.now() - t1}ms`
  );
} catch (err) {
  handlerErr = err;
  console.error(
    "[server] init: @remix-run/express IMPORT FAILED:",
    err && err.stack
  );
}

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.get("/__diag", (_req, res) => {
  res.json({
    node: process.version,
    cwd: process.cwd(),
    PORT: process.env.PORT,
    NODE_ENV: process.env.NODE_ENV,
    remixLoaded: !!build,
    remixBuildKeys: build ? Object.keys(build) : null,
    buildError: buildErr
      ? { name: buildErr.name, message: buildErr.message, stack: buildErr.stack }
      : null,
    handlerError: handlerErr
      ? {
          name: handlerErr.name,
          message: handlerErr.message,
          stack: handlerErr.stack,
        }
      : null,
  });
});

if (build && createRequestHandler) {
  app.all(
    "*",
    createRequestHandler({
      build,
      mode: process.env.NODE_ENV ?? "production",
    })
  );
  console.log("[server] init: Remix handler registered");
} else {
  app.all("*", (_req, res) => {
    res
      .status(500)
      .type("text/plain")
      .send(
        [
          "Remix failed to initialize.",
          `buildError: ${buildErr ? buildErr.message : "(none)"}`,
          `handlerError: ${handlerErr ? handlerErr.message : "(none)"}`,
          "See /__diag for full stacks.",
        ].join("\n") + "\n"
      );
  });
  console.warn("[server] init: serving 500 fallback (Remix unavailable)");
}

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});
