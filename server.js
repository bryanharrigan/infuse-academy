// Minimal Express entrypoint for AWS Amplify Hosting's SSR compute runtime.
//
// Amplify's deployment spec expects a Node entrypoint that listens on
// process.env.PORT and serves HTTP traffic. amplify.yml reshapes the build
// so this file lives at .amplify-hosting/compute/default/server.js with the
// Remix server bundle at ./server/index.js (relative to this file).
//
// Static imports (no top-level await) and a verbose startup log help us
// diagnose Lambda cold-start crashes via CloudWatch.

import { createRequestHandler } from "@remix-run/express";
import express from "express";
import * as build from "./server/index.js";

console.log("[server] booting Remix Express handler");
console.log("[server] NODE_ENV =", process.env.NODE_ENV);
console.log("[server] PORT =", process.env.PORT);
console.log("[server] build keys =", Object.keys(build));

const app = express();
app.disable("x-powered-by");

app.all(
  "*",
  createRequestHandler({
    build,
    mode: process.env.NODE_ENV ?? "production",
  })
);

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[server] Remix listening on :${port}`);
});
