/**
 * test/lti.test.ts
 *
 * Self-contained checks for the LTI tool's crypto and URL handling. No Absorb
 * portal and no LMS required: a local HTTP server stands in for the
 * platform's JWKS endpoint, so the full verify path — fetch, kid selection,
 * RS256 signature, issuer/audience/expiry/nonce — runs for real.
 *
 * Run:  node test/run.mjs
 */

import crypto from "node:crypto";
import http from "node:http";
import assert from "node:assert/strict";

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL ${name}`);
    console.log(`       ${err instanceof Error ? err.message : String(err)}`);
  }
}

/* The tool key has to exist before the modules under test are imported,
 * because keys.ts reads the env var at module scope. */
const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
process.env.LTI_TOOL_PRIVATE_KEY = privateKey as unknown as string;
process.env.LTI_TOOL_KID = "test-kid";
process.env.PUBLIC_URL = "https://tool.example";
process.env.LTI_PROVISION_SECRET = "test-secret-value";

const { toolJwks } = await import("~/.server/lti/keys");
const { signToolJwt, verifyPlatformJwt, jwtInternals } = await import(
  "~/.server/lti/jwt"
);
const { scoresUrl } = await import("~/.server/lti/ags");
const { deterministicUsername } = await import("~/.server/lti/portal");
const { splitName } = await import("~/.server/lti/claims");

/* A stand-in platform: it publishes our own public key, so anything we sign
 * verifies as if the platform had signed it. That lets the verifier be
 * exercised without a second keypair. */
const jwks = toolJwks();
const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(jwks));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const JWKS_URL = `http://127.0.0.1:${port}/jwks`;

const ISS = "https://host.myabsorb.com";
const AUD = "client-123";

function makeToken(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return signToolJwt({
    iss: ISS,
    aud: AUD,
    sub: "user-abc",
    nonce: "nonce-1",
    iat: now,
    exp: now + 600,
    ...overrides,
  });
}

const verify = (token: string) =>
  verifyPlatformJwt(token, {
    jwksUrl: JWKS_URL,
    expectedIssuer: ISS,
    expectedAudience: AUD,
  });

async function expectReject(fn: () => Promise<unknown>, match: RegExp) {
  let threw = false;
  try {
    await fn();
  } catch (err) {
    threw = true;
    const msg = err instanceof Error ? err.message : String(err);
    assert.match(msg, match, `wrong rejection message: ${msg}`);
  }
  assert.equal(threw, true, "expected a rejection, got success");
}

console.log("\nJWKS");
await check("publishes one RSA key with kid, alg and use", () => {
  assert.equal(jwks.keys.length, 1);
  const k = jwks.keys[0];
  assert.equal(k.kty, "RSA");
  assert.equal(k.kid, "test-kid");
  assert.equal(k.alg, "RS256");
  assert.equal(k.use, "sig");
  assert.ok(k.n && k.e, "modulus and exponent must be present");
});
await check("never exposes private key material", () => {
  const serialised = JSON.stringify(jwks);
  for (const field of ['"d"', '"p"', '"q"', '"dp"', '"dq"', '"qi"']) {
    assert.ok(!serialised.includes(field), `JWKS leaked ${field}`);
  }
});

console.log("\nid_token verification");
await check("accepts a well-formed token", async () => {
  const claims = await verify(makeToken());
  assert.equal(claims.sub, "user-abc");
  assert.equal(claims.nonce, "nonce-1");
});
await check("rejects a tampered payload", async () => {
  const [h, p, s] = makeToken().split(".");
  const decoded = JSON.parse(jwtInternals.b64urlDecode(p).toString("utf8"));
  decoded.sub = "someone-else";
  const forged = jwtInternals.b64urlEncode(JSON.stringify(decoded));
  await expectReject(() => verify(`${h}.${forged}.${s}`), /signature/i);
});
await check("rejects alg:none", async () => {
  const header = jwtInternals.b64urlEncode(
    JSON.stringify({ alg: "none", typ: "JWT" })
  );
  const payload = jwtInternals.b64urlEncode(
    JSON.stringify({ iss: ISS, aud: AUD, sub: "x" })
  );
  await expectReject(() => verify(`${header}.${payload}.`), /alg|segments/i);
});
await check("rejects HS256 signed with the public key as secret", async () => {
  const header = jwtInternals.b64urlEncode(
    JSON.stringify({ alg: "HS256", typ: "JWT", kid: "test-kid" })
  );
  const payload = jwtInternals.b64urlEncode(
    JSON.stringify({ iss: ISS, aud: AUD, sub: "x" })
  );
  const sig = jwtInternals.b64urlEncode(
    crypto.createHmac("sha256", "whatever").update(`${header}.${payload}`).digest()
  );
  await expectReject(() => verify(`${header}.${payload}.${sig}`), /alg/i);
});
await check("rejects a mismatched issuer", async () => {
  await expectReject(
    () => verify(makeToken({ iss: "https://evil.example" })),
    /iss/i
  );
});
await check("rejects a token addressed to another client", async () => {
  await expectReject(() => verify(makeToken({ aud: "other-client" })), /aud/i);
});
await check("accepts aud as an array containing our client_id", async () => {
  const claims = await verify(makeToken({ aud: ["other", AUD] }));
  assert.equal(claims.sub, "user-abc");
});
await check("rejects an expired token", async () => {
  const past = Math.floor(Date.now() / 1000) - 7200;
  await expectReject(
    () => verify(makeToken({ iat: past, exp: past + 60 })),
    /expired/i
  );
});
await check("rejects an unknown kid", async () => {
  process.env.LTI_TOOL_KID_UNUSED = "1";
  const [h, p, s] = makeToken().split(".");
  const header = JSON.parse(jwtInternals.b64urlDecode(h).toString("utf8"));
  header.kid = "not-a-real-kid";
  const reheaded = jwtInternals.b64urlEncode(JSON.stringify(header));
  await expectReject(() => verify(`${reheaded}.${p}.${s}`), /kid/i);
});

console.log("\nAGS score URL");
await check("appends /scores to a plain line item URL", () => {
  assert.equal(
    scoresUrl("https://host.example/lti/lineitems/42"),
    "https://host.example/lti/lineitems/42/scores"
  );
});
await check("inserts /scores before an existing query string", () => {
  assert.equal(
    scoresUrl("https://host.example/lti/lineitems?id=42&type_id=7"),
    "https://host.example/lti/lineitems/scores?id=42&type_id=7"
  );
});
await check("tolerates a trailing slash", () => {
  assert.equal(
    scoresUrl("https://host.example/lineitems/42/"),
    "https://host.example/lineitems/42/scores"
  );
});

console.log("\nIdentity derivation");
await check("username is stable across calls", () => {
  const a = deterministicUsername(ISS, "user-abc");
  const b = deterministicUsername(ISS, "user-abc");
  assert.equal(a, b);
  assert.ok(a.startsWith("lti-"));
  assert.ok(a.length <= 255);
});
await check("different issuers never collide on the same sub", () => {
  // The cross-customer collision a bare SCORM student_id would have caused.
  assert.notEqual(
    deterministicUsername("https://portal-a.example", "12345"),
    deterministicUsername("https://portal-b.example", "12345")
  );
});
await check("splitName handles the shapes platforms actually send", () => {
  assert.deepEqual(splitName("Harrigan, Bryan"), { first: "Bryan", last: "Harrigan" });
  assert.deepEqual(splitName("Bryan Harrigan"), { first: "Bryan", last: "Harrigan" });
  assert.deepEqual(splitName("Ada Byron Lovelace"), {
    first: "Ada Byron",
    last: "Lovelace",
  });
  assert.deepEqual(splitName(null), { first: "LTI", last: "Learner" });
  assert.deepEqual(splitName("Cher"), { first: "Cher", last: "Cher" });
});

server.close();
console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
