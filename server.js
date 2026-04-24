// Minimal Express entrypoint for AWS Amplify Hosting's SSR compute runtime.
//
// Amplify's deployment spec expects a single Node entrypoint (per
// deploy-manifest.json -> computeResources.entrypoint) that listens on
// process.env.PORT and serves the app.
//
// At build time, amplify.yml reshapes the Remix build output so that:
//   - this file lives at .amplify-hosting/compute/default/server.js
//   - the Remix server bundle is at ./server/index.js (relative to this file)
//   - public/ static files are served from the sibling .amplify-hosting/static/
//     directory (handled by Amplify itself, not by this Express server)
//
// We only need to handle Remix's SSR routes here — static assets are served
// directly by Amplify's edge/CDN layer via the "Static" routes in
// deploy-manifest.json.
import { createRequestHandler } from "@remix-run/express";
import express from "express";

const build = await import("./server/index.js");

const app = express();
app.disable("x-powered-by");

app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV,
  })
);

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Remix server listening on :${port}`);
});
