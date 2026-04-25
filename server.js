// Express entrypoint for AWS Amplify Hosting's SSR compute runtime.
//
// amplify.yml reshapes the Remix build so this file lives at
// .amplify-hosting/compute/default/server.js with the Remix server bundle
// at ./server/index.js (relative to this file). Static assets are served
// from .amplify-hosting/static/ by Amplify's edge layer based on
// deploy-manifest.json — this Express app only handles SSR routes.
//
// We use top-level await to load the Remix build during Lambda's INIT
// phase. Background async work in Lambda is suspended between invocations,
// so a deferred import may never resolve.

import { createRequestHandler } from "@remix-run/express";
import express from "express";

const build = await import("./server/index.js");

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV ?? "production",
  })
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`Remix server listening on :${port}`);
});
