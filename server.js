// Bare-minimum Express server for diagnosing Amplify Hosting compute.
// No Remix, no app code — just confirms the runtime starts and serves traffic.
// Once this works, we'll restore the Remix handler.

import express from "express";

console.log("[server] starting bare-bones Express diagnostic");
console.log("[server] node version:", process.version);
console.log("[server] cwd:", process.cwd());
console.log("[server] PORT:", process.env.PORT);

const app = express();
app.disable("x-powered-by");

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.all("*", (req, res) => {
  res.type("text/plain").send(
    [
      "Hello from Amplify Hosting compute!",
      `path: ${req.path}`,
      `method: ${req.method}`,
      `host: ${req.headers.host}`,
      `node: ${process.version}`,
    ].join("\n") + "\n"
  );
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`[server] listening on :${port}`);
});
