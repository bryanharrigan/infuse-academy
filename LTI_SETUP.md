# Cross-portal LTI 1.3 tool

Plays an Online Course that lives on one Absorb portal (**source**) inside a
course on a different Absorb portal (**host**), through LTI 1.3.

The host portal is the LTI Consumer — the direction Absorb's native LTI
already runs. This app is the Tool. Absorb never has to act as an LTI
provider anywhere in the chain.

```
host portal  ──LTI launch──▶  this app  ──Infuse APIs──▶  source portal player
     ▲                            │
     └────── AGS score ───────────┴──◀── Absorb completion webhook
```

**Online courses only.** The deep-link picker filters the source catalog to
`OnlineCourse` before the admin sees it, so a curriculum or instructor-led
course can never be selected into a link that cannot play.

---

## What reports where

| Destination | Mechanism | Built? |
|---|---|---|
| Source portal | Native — it is the real Absorb player with a real enrolment, so progress, attempts, scores, completion and certificates all record themselves | nothing to build |
| Host portal | AGS score, triggered by the source portal's completion webhook | `ags.ts` + `api.lti.webhook.ts` |

---

## Files

| File | Role |
|---|---|
| `app/.server/lti/keys.ts` | Tool RSA key, JWKS derived from it |
| `app/.server/lti/jwt.ts` | RS256 sign/verify, platform JWKS fetch + cache |
| `app/.server/lti/platforms.ts` | Registered host portals (`LTI_PLATFORMS`) |
| `app/.server/lti/claims.ts` | LTI claim URIs and typed readers |
| `app/.server/lti/store.ts` | Pending logins and launch records |
| `app/.server/lti/deeplink-store.ts` | In-flight deep-linking requests |
| `app/.server/lti/portal.ts` | Portal-scoped Absorb client: provision, enrol, mint, catalog |
| `app/.server/lti/ags.ts` | Score passback |
| `app/routes/lti.jwks.ts` | `GET /lti/jwks` |
| `app/routes/lti.login.ts` | `GET`/`POST /lti/login` — OIDC login initiation |
| `app/routes/lti.launch.ts` | `POST /lti/launch` — verified entry point |
| `app/routes/lti.deeplink.tsx` | Content picker + signed deep-linking response |
| `app/routes/lti.play.tsx` | Provision, enrol, mint, frame the player |
| `app/routes/api.lti.webhook.ts` | Absorb completion → AGS |
| `test/lti/` | 17 self-contained crypto/URL checks |

No existing file was modified. No dependency was added — `node:crypto` covers
RS256 and JWK import/export, and this repo's deploy fails when `package.json`
and the lockfile drift.

---

## Setup

### 1. Generate the tool key

```
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out lti-private.pem
```

Put the PEM in `LTI_TOOL_PRIVATE_KEY`. It must stay stable across deploys —
rotating it invalidates every platform registration that cached our JWKS,
which presents as deep links silently failing to save.

### 2. Register the tool in the host portal

Client Settings → LTI Registration. Give it:

| Field | Value |
|---|---|
| Login / OIDC initiation URL | `{PUBLIC_URL}/lti/login` |
| Launch / redirect URL | `{PUBLIC_URL}/lti/launch` |
| Public keyset (JWKS) URL | `{PUBLIC_URL}/lti/jwks` |
| Deep linking URL | `{PUBLIC_URL}/lti/launch` |

The redirect URL must match character for character — a trailing slash
difference is the usual cause of a launch that dies at the platform with no
useful message.

Take the client id, deployment id and the portal's own auth/token/JWKS URLs
back out of that screen and into `LTI_PLATFORMS`.

### 3. Configure the source portal

See `env.lti.example`. Defaults fall back to the app's existing `INFUSE_*`
vars, so pointing at a second portal only needs the `LTI_SOURCE_*` overrides.

The admin REST host is **region-specific** and is not the same host as the
tenant Integration API:

```
US  https://rest.myabsorb.com      CA  https://rest.myabsorb.ca
EU  https://rest.myabsorb.eu       AU  https://rest.myabsorb.com.au
```

Add this app's origin to the source portal's **Absorb Allow List** (Portal
Settings → Info), or the player will refuse to frame.

### 4. Webhook

Source portal → Client Settings → Webhooks:

- URL: `{PUBLIC_URL}/api/lti/webhook`
- Events: `Enrollment Completed by Learner` (and `by Admin` if you want them)
- Secret: copy into `LTI_WEBHOOK_SECRET`

`GET /api/lti/webhook` reports whether the secret is configured.

### 5. Build the course on the host portal

Add an Online Course → Add Learning Object → **LTI Learning Objects** →
select this tool → **Add Content** → pick a source course from the picker.

Per Absorb's Consumer Mode documentation the picker is the only documented
way to create the Learning Object, which is why deep linking is implemented
rather than a manual URL field.

---

## Tests

```
node test/lti/run.mjs
```

17 checks, no portal and no LMS required: a local HTTP server stands in for
the platform's JWKS endpoint so the full verify path runs for real —
signature, `kid` selection, issuer, audience, expiry. The negative cases
cover the three classic JWT bypasses (`alg:none`, HS256 confusion, tampered
payload), plus the `/scores` URL construction and identity derivation.

---

## Known limits — read before trusting this in front of anyone

**The admin enrolment path is unverified.** `portal.ts` posts to
`{rest}/users/{userId}/enrollments/{courseId}?ReEnroll=false`, taken from
Absorb's generated API help index rather than a spec read end to end. If it
404s, check the OpenAPI document on `docs.myabsorb.com` before changing
anything else — every other failure mode here looks identical from outside.

**Launch records are in-memory.** The gap between a learner finishing and the
webhook firing can be minutes; for a graded lesson awaiting a human it can be
days. A redeploy in between loses the mapping and the score never arrives.
The webhook logs the miss. For a demo this is fine; the seam for a real store
is `store.ts` and nowhere else.

**The password is derived, not random.** `LTI_PROVISION_SECRET` (falling back
to `COOKIE_SECRET`) derives a stable password per learner, so every launch
sends the same value to `POST /users` and the upsert never has to change it.
Rotating that secret orphans every provisioned learner — the account still
exists but we can no longer sign in as it.

**Three-deep framing.** Host portal → this app → source player. Only
`/learn/lessonplayer` frames; `/learn/v2/coursePlayer` sends
`X-Frame-Options: SAMEORIGIN`. When no lesson id resolves we land on the
latter and the page offers a new window instead of a frame that silently
refuses to paint. Absorb's Allow List check is server-side from the Referer
of the player request — which is always this app — so one entry covers every
host portal.

**Licensing.** Every host-portal learner who launches becomes a source-portal
user. Same human, two portals, two counts.

**Lessons someone else completes.** An Assignment task awaiting a grader
completes long after the learner's session ended. AGS still delivers whenever
the webhook fires, but not in the same sitting — don't demo those and imply
instant passback.
