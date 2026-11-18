/**
 * scripts/lti-keygen.mjs
 *
 * Generates the secrets the LTI tool needs and prints them in a form you can
 * paste straight into the `Infuse` service's environment.
 *
 *   node scripts/lti-keygen.mjs
 *
 * Writes nothing to disk and sends nothing anywhere — the private key exists
 * only in this process's output, so whatever you do with it is deliberate.
 *
 * WHAT IT MAKES
 * -------------
 *   LTI_TOOL_PRIVATE_KEY   RS256 keypair. The public half is served from
 *                          /lti/jwks and is what the host portal uses to
 *                          verify our deep-linking responses and AGS
 *                          assertions.
 *   LTI_PROVISION_SECRET   HMAC key that derives each provisioned learner's
 *                          stable password.
 *
 * BOTH MUST STAY STABLE.
 *   - Rotating the key invalidates every platform registration that cached
 *     our JWKS. Deep links stop saving, and nothing says why.
 *   - Rotating the provision secret orphans every learner already created:
 *     the account still exists, but we can no longer sign in as it.
 *
 * NEVER COMMIT THE OUTPUT. This repo is public. The env lives in the `Infuse`
 * service's NSSM AppEnvironmentExtra on the origin machine, not in a file —
 * remix-serve does not read .env, and C:\Infuse\.env.production is dormant.
 */

import crypto from "node:crypto";

const { privateKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

/** Escaped to a single line: NSSM environment values cannot span lines. */
const oneLineKey = privateKey.trimEnd().replace(/\r?\n/g, "\\n");

const provisionSecret = crypto.randomBytes(48).toString("base64");

/** Sanity-check that what we printed can be read back. keys.ts does the same. */
const roundTripped = crypto.createPrivateKey(oneLineKey.replace(/\\n/g, "\n"));
const jwk = crypto.createPublicKey(roundTripped).export({ format: "jwk" });

console.log(`
Generated. Paste these into the Infuse service environment on the origin
machine (nssm edit Infuse -> Environment), then:

    sc.exe stop Infuse
    sc.exe start Infuse

nssm restart fails on that box — stop and start separately. Never delete and
re-register the service; its whole environment lives under it in the registry.

--------------------------------------------------------------------------
LTI_TOOL_PRIVATE_KEY=${oneLineKey}

LTI_PROVISION_SECRET=${provisionSecret}
--------------------------------------------------------------------------

Self-check: the key above parses, and its public half is
  kty=${jwk.kty}  e=${jwk.e}  n=${String(jwk.n).slice(0, 24)}…

After the restart, GET https://infuse.bryanharrigan.dev/lti/jwks should show
a key with that same modulus and "kid":"infuse-lti-1". If it 500s, the value
lost its \\n escapes somewhere between here and the service.

NEVER COMMIT THIS OUTPUT — this repo is public.
`);
