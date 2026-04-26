# Infuse Academy / RadNet LMS — Project Context

A handoff document describing the project, architecture, and key technical
decisions. Intended to be dropped into a Claude Project's knowledge base so
future Claude chats start with full context.

---

## 1. What this project is

`infuse-local` is a Remix-based, non-WordPress rebuild of an LMS front-end
that integrates with **Absorb Infuse** (the LMS-as-a-service product from
Absorb, tenant: `bryanh.myabsorb.com`). It is a local/dev version of the
production "Infuse Academy" experience and serves as a testbed for:

- A Sana Labs–inspired dashboard for learners (Learning Hub).
- Multiple theme variants over the same layout engine:
  - **Default** — plain MUI light look (original Infuse starter).
  - **Infuse Academy** — dark mode, gradient accents, Space Grotesk
    display font, animated hero and progress rings.
  - **RadNet** — light mode corporate branding modelled on
    [radnet.com](https://www.radnet.com) (red + navy/sky-blue palette,
    Open Sans, two-tier header, radnet.com home banner image, a RadNet-
    only footer mirroring the real site).
- An embedded **lesson player** and **course player** that open inside
  a modal rather than navigating away.

---

## 2. Tech stack

- **Remix** (v2.10) on Vite
- **React** + **TypeScript**
- **MUI v5** (Material UI) with Emotion for CSS-in-JS
- **Tailwind CSS** (used lightly; most theme styling is raw CSS in
  `app/styles/infuse-academy.css`)
- **Node** backend via Remix loaders/actions
- **Absorb Infuse API** for auth, catalog, enrollments, lessons, news

---

## 3. Repository layout

```
app/
  .server/                    # Server-only code (NEVER imported from client)
    infuse-api.ts             # ALL Absorb Infuse HTTP calls live here
    course.resource.ts        # Course shape
    my-courses.resource.ts    # My-courses shape
    my-course-enrollment.resource.ts
    course-type.type.ts

  components/
    course-card/              # Card used in My Courses + Catalog grids
    footer/                   # RadNet-only footer (self-conditional)
    header/                   # Top nav (two-tier layout under RadNet)
    logo/                     # IA / RadNet inline SVG logos
    modal/
      course-detail-modal.tsx # "About this course" dialog
      course-player-modal.tsx # Multi-lesson sidebar modal
      lesson-player-modal.tsx # Single-lesson iframe modal
      loading-spinner-modal.tsx
      toast-notification.component.tsx  # "Enrolling..." toast

  constants/
    infuse-cookie.server.ts   # infuseJwt cookie (tenant JWT, HttpOnly)

  context/
    app-state.context.tsx     # themeVariant + setter; localStorage-backed
    client-style.context.ts   # Emotion cache reset on hydrate

  emotion/
    create-emotion-cache.ts

  hooks/
    use-current-user.hook.ts

  mui/
    theme.ts                  # Default MUI theme
    theme-infuse-academy.ts   # Dark-mode IA MUI theme
    theme-radnet.ts           # Light-mode RadNet MUI theme

  routes/
    _index.tsx                # Landing / marketing page
    signin.tsx                # Redirect-only loader → Absorb OAuth /authorize
    auth.callback.tsx         # OAuth callback: code → JWT cookie
    signout.tsx
    learning-hub.tsx          # Sana-style dashboard (primary homepage)
    my-courses.tsx            # Enrolled-courses grid + gamification
    catalog.tsx               # All available courses + search
    course-player.$courseId.tsx   # Route alternative to modal
    lesson-player.$courseId.tsx   # Route alternative to modal
    use-my-courses.hook.ts
    use-catalog.hook.ts

  .server/
    infuse-api.ts             # Absorb HTTP calls (loaders consume these)
    infuse-oauth.ts           # OAuth 2.0 helpers (authorize URL, token exchange)
    ...resource type files

  styles/
    infuse-academy.css        # ~1700 lines of theme CSS (IA + RadNet)

  tailwind.css
  root.tsx                    # Document shell, theme switch, auth loader
  entry.client.tsx            # Emotion cache hydration
  entry.server.tsx            # SSR entry

amplify.yml                   # Amplify build spec (reshapes build/ → .amplify-hosting/)
deploy-manifest.json          # Amplify SSR deployment spec
server.js                     # Express entrypoint for the SSR Lambda
AWS_MIGRATION.md              # Step-by-step record of the Amplify migration
vite.config.ts                # HTTPS certs, HTTP/1.1 forced, allowedHosts, ssr.noExternal
```

---

## 4. Theme system — how the three variants share one layout

### Context flag

`app/context/app-state.context.tsx` exposes `themeVariant`:

```ts
type ThemeVariant = "default" | "infuse-academy" | "radnet";
```

Stored in `localStorage` and toggled via a dropdown in the header.

### MUI side

`root.tsx` wraps the app in a `ThemedShell` that picks one of three MUI
themes based on the context flag:

```tsx
themeVariant === "radnet"         → radnetTheme
themeVariant === "infuse-academy" → infuseAcademyTheme
default                           → defaultTheme
```

### CSS side

The `<body>` element gets class names based on the variant:

- `default`         → no special classes
- `infuse-academy`  → `theme-ia`
- `radnet`          → `theme-ia theme-radnet`  ← **both** classes

Why both? The **RadNet variant reuses the entire Infuse Academy layout**
(hero, gamification bar, progress rings, cards, etc.) — it only overrides
palette, surfaces, and a few component-level tweaks. So:

- `body.theme-ia .*` rules define the shared IA layout
- `body.theme-radnet .*` rules in the same stylesheet override IA where
  needed (light surfaces, RadNet red/blue, corporate fonts, two-tier
  header)

### Specificity gotcha (important)

When a body has **both** `theme-ia` and `theme-radnet` classes, rules for
each have equal specificity. The rule declared **later** in the stylesheet
wins. This bit us twice:

1. **Header logo visibility**: `body.theme-ia .ia-header__logo-img
   { display: none }` was declared AFTER the RadNet rule that showed it.
   Fix was to use `body.theme-ia:not(.theme-radnet)` and place that rule
   BEFORE the RadNet overrides (search `:not(.theme-radnet)` in the CSS
   file for the pattern).

2. **Footer link color**: `body.theme-ia a { color: var(--ia-accent-1) }`
   was winning over `.rn-footer__social-link { color: #ffffff }` because
   the body-scoped selector had higher specificity. Fix was to scope
   footer link rules as `body.theme-radnet .rn-footer__social-link`.

### CSS variables (theme tokens)

Defined on `:root` (IA defaults) and redefined under `body.theme-radnet`:

| Token                  | IA (dark)           | RadNet (light)                 |
| ---------------------- | ------------------- | ------------------------------ |
| `--ia-black`           | `#0a0a0f`           | `#ffffff`                      |
| `--ia-surface`         | `#1a1a2e`           | `#ffffff`                      |
| `--ia-surface-2`       | `#222240`           | `#f7f8fa`                      |
| `--ia-accent-1`        | `#6c63ff` (purple)  | `#c82030` (red)                |
| `--ia-accent-2`        | `#ff6584` (pink)    | `#0e78be` (sky blue)           |
| `--ia-text`            | `#f0f0f5`           | `#212529`                      |
| `--ia-text-muted`      | `#8888a0`           | `#706f70`                      |
| `--ia-gradient-primary`| purple→pink         | red→dark-red                   |

Because most components consume `--ia-*` vars, flipping themes works
mostly automatically. Only components with bespoke color literals need
explicit `body.theme-radnet` overrides.

### SVG gradient that follows the theme

`root.tsx` defines an off-screen SVG `<linearGradient id="ia-ring-gradient">`
whose stops are `stopColor="var(--ia-accent-1, #6c63ff)"` etc. The
progress-ring components reference `url(#ia-ring-gradient)`, so their
stroke automatically recolors when the theme flips.

---

## 5. Absorb Infuse API — what works, what doesn't

All calls live in `app/.server/infuse-api.ts`. Host split:

- **Infuse API host**: `https://infuseapi.myabsorb.com` (public API)
- **Tenant host**: `https://bryanh.myabsorb.com` (auth, lesson player)

### Auth — what we actually do (OAuth 2.0 Authorization Code flow)

1. User hits `/signin` → loader generates a random `state`, stashes it
   in a short-lived `infuseJwtCookie`-style state cookie, and 302-redirects
   to `https://bryanh.myabsorb.com/oauth/authorize?client_id=...&...`.
2. User logs in on **Absorb's hosted login page** (their own IP, no WAF
   block — see Amplify gotchas below for why this matters).
3. Absorb redirects to `https://infuse.bryanharrigan.dev/auth/callback?code=...&state=...`.
4. The callback loader verifies state, then POSTs to
   `https://bryanh.myabsorb.com/oauth/token` with `grant_type=authorization_code`
   to receive an `access_token` (4-hour JWT).
5. The access_token is stored in `infuseJwtCookie` (HttpOnly, signed)
   and used as `Authorization: Bearer <jwt>` for subsequent Infuse API calls.

The OAuth client ID/secret live in `INFUSE_OAUTH_CLIENT_ID` and
`INFUSE_OAUTH_CLIENT_SECRET` env vars (sourced from Absorb admin →
Portal Settings → Absorb Infuse Access). All OAuth wiring is in
`app/.server/infuse-oauth.ts`; the routes that drive the round-trip are
`app/routes/signin.tsx` (redirect to /authorize) and
`app/routes/auth.callback.tsx` (code → token exchange).

> **Why OAuth, not basic auth?** The legacy
> `POST /api/rest/v2/authentication` endpoint (also exposed at
> `infuse.myabsorb.com/authentication` via API Gateway) returns 403
> Forbidden when called from AWS Lambda IP ranges — Absorb's WAF flags
> datacenter traffic. The OAuth flow bypasses this because the user's
> credentials are entered on Absorb's site from their own IP; the
> `/oauth/token` exchange that does happen server-to-server is not
> rate-limited the same way.

### Endpoints we use

| Purpose               | Method / Path                                                 |
| --------------------- | ------------------------------------------------------------- |
| OAuth authorize       | `GET  {tenant}/oauth/authorize` (browser redirect)            |
| OAuth token exchange  | `POST {tenant}/oauth/token` (server-to-server)                |
| Profile               | `GET /api/rest/v2/users/me` (Infuse API)                      |
| Avatar                | `GET /api/rest/v2/users/me/avatar` (Infuse API)               |
| My courses            | `GET /my-courses?limit=30&showCompleted=true` (Infuse API)    |
| Catalog               | `GET /my-catalog?limit=30&showCompleted=true` (Infuse API)    |
| Enroll                | `POST /enrollments` with `{courseId}` (Infuse API)            |
| Enrollment status     | `GET /my-courses/{id}/enrollment` (Infuse API)                |
| Course chapters       | `GET /online-courses/{id}/chapters` (Infuse API)              |
| News                  | `GET /my-news-articles` (Infuse API)                          |
| Lesson player URL     | `{tenant}/learn/lessonplayer?lessonId={id}` (NOT the API)     |

### Endpoint pitfalls

- **`limit=50` returns 422.** Absorb's max page size is 30.
- **There is no `/courses/{id}/chapters` endpoint.** Use
  `/online-courses/{id}/chapters`. The Absorb sample code at
  `~/Downloads/absorb-infuse-code-sample - main 7/` was the authoritative
  reference that unblocked lesson-player work.
- **`/learn/v2/coursePlayer` redirects to the tenant root** which has
  `X-Frame-Options: SAMEORIGIN` — it cannot be iframed. The workaround
  is to hit `/learn/lessonplayer?lessonId={id}` per-lesson and build our
  own sidebar/chapter navigation on top. See `course-player-modal.tsx`.
- **Verifier** (for the lesson player) is hardcoded; the OAuth dance for
  the lesson player is separate from our user-facing OAuth flow.
- **`infuse.myabsorb.com/oauth/authorize` returns "Missing Authentication
  Token".** Despite the OpenAPI spec listing `infuse.myabsorb.com` as the
  Server, that host's `/oauth/authorize` is an AWS API Gateway proxy
  with the wrong auth model. The real OAuth front-end lives on the
  tenant subdomain (`bryanh.myabsorb.com/oauth/authorize`). Same goes
  for `/oauth/token`.
- **Basic-auth `/authentication` returns 403 from AWS IPs.** Documented
  as "user must change password" in the schema, but for us it's actually
  a WAF datacenter-block. Don't use this path on Lambda — use OAuth.

---

## 6. Lesson & Course Players

Two modals, serving different scopes:

### `lesson-player-modal.tsx`

- Opened when a user clicks a card's "Start"/"Resume"/"Review" button.
- Shows a single iframe pointing at `/learn/lessonplayer?lessonId={id}`
  for the first chapter's first lesson.

### `course-player-modal.tsx`

- Opened from the Learning Hub's Progress Breakdown bars and from any
  place that wants a full multi-lesson experience.
- Sidebar on the left lists all chapters → lessons from
  `/online-courses/{id}/chapters`.
- Clicking a lesson swaps the iframe `src` to that lesson's
  `/learn/lessonplayer?lessonId=X`.
- Completed lessons show a "Review" affordance so the course stays
  replayable (buttons on `CourseCard` labelled "Review" when
  `enrollmentStatus === "Complete" | "Completed"`).

---

## 7. Local development

Production is on AWS Amplify (Section 8). For local dev:

```bash
cd ~/Projects/infuse-local
npm install        # first time
npm run dev
```

Open `http://localhost:5173`. Sign-in still works because the OAuth
flow redirects you to Absorb's hosted page from your own IP — no tunnel
needed. Make sure your local `.env` has the same vars Amplify uses:

```
INFUSE_API_KEY=...
INFUSE_API_URL=https://infuse.myabsorb.com
INFUSE_BASE_URL=https://bryanh.myabsorb.com/api/rest/v2
INFUSE_PORTAL_URL=https://bryanh.myabsorb.com
INFUSE_OAUTH_CLIENT_ID=...
INFUSE_OAUTH_CLIENT_SECRET=...
COOKIE_SECRET=...      # any 32+ random bytes for local
```

Use `https://infuse.bryanharrigan.dev/auth/callback` as the OAuth redirect
even when developing — Absorb sends the user there, and the cookie set by
the production app is on the same hostname so you'll be signed in across
both. If you need a separate dev redirect, register a second OAuth client
in Absorb with `http://localhost:5173/auth/callback`.

### Vite config highlights (`vite.config.ts`)

- `host: "0.0.0.0"` — listen on all interfaces (needed if you reintroduce
  a tunnel for local-only Absorb-allowlist scenarios).
- `allowedHosts: ["infuse.bryanharrigan.dev"]` — Vite 5 rejects other
  Host headers by default.
- `server.proxy: {}` — seemingly a no-op, but it forces Vite to use
  `https.createServer` (HTTP/1.1) instead of
  `http2.createSecureServer({ allowHTTP1: true })`. Without this,
  Chrome negotiates HTTP/2 and Remix 2.10's Node adapter crashes with
  `Headers.set: ":method" is an invalid header name` because it can't
  strip HTTP/2 pseudo-headers.
- A custom Vite plugin `strip-h2-pseudo-headers` strips any `:method`,
  `:path`, `:scheme`, `:authority` headers as defence-in-depth in case
  HTTP/2 slips through.
- `ssr.noExternal: [/^@mui\//, /^@emotion\//]` — bundles MUI and Emotion
  into the SSR output. Without this, the Lambda fails at import with
  `ERR_UNSUPPORTED_DIR_IMPORT` (see Amplify gotchas).
- Local HTTPS via self-signed certs in `./certs/` (optional — falls
  through to HTTP when absent).

### Historical: Cloudflare tunnel (now retired)

Pre-migration, dev traffic went through a Cloudflare Tunnel
(`infuse.bryanharrigan.dev` → `cloudflared` → `localhost:5173`) so dev
shared the production hostname for Absorb's allow-list. With OAuth in
place, that hostname only matters for the redirect URI; the actual
Absorb traffic from local dev now hits `bryanh.myabsorb.com` directly
from your IP, which the WAF allows. The tunnel was deleted in
Cloudflare Zero Trust → Networks → Connectors after the migration.

---

## 8. Production deployment (AWS Amplify)

The app is hosted on **AWS Amplify Hosting** with `bryanharrigan.dev`
on Cloudflare in front. Migration documented in `AWS_MIGRATION.md`.

### Architecture

```
Browser ──HTTPS──> Cloudflare edge (TLS terminates, WAF, caching)
                   │
                   ▼
                   Cloudflare Worker  infuse-origin-proxy
                   │  Rewrites URL hostname + Host header so fetch()
                   │  opens TLS to the stable Amplify branch URL.
                   ▼
                   AWS CloudFront (Amplify-managed)
                   │  via main.d1htx1hpyczhg6.amplifyapp.com
                   ▼
                   AWS Amplify SSR Lambda (Node 20, us-east-1)
                   │
                   ▼ (server fetch)
                   Absorb Infuse API
```

- **Browser** always sees `https://infuse.bryanharrigan.dev` — that's
  the host Absorb's allow-list trusts.
- **Cloudflare** stays in front (free plan; SSL/TLS mode = Full (Strict)).
  WAF, DDoS protection, and edge caching are preserved.
- **Cloudflare Worker** `infuse-origin-proxy` is bound as a Custom domain
  on `infuse.bryanharrigan.dev` (no DNS CNAME needed — the Worker binding
  IS the routing). The Worker rewrites the request URL's hostname to
  `main.d1htx1hpyczhg6.amplifyapp.com` before `fetch()`, which (a) makes
  Workers fetch use the right SNI so AWS CloudFront accepts the TLS
  handshake against its `*.amplifyapp.com` cert, and (b) forces the
  `Host` header to a value Amplify's CloudFront recognizes for routing.
  Source lives in `scripts/cloudflare-worker-amplify-proxy.js`.
- **Amplify** runs the SSR Lambda from a custom `.amplify-hosting/`
  deployment spec (see `amplify.yml` and `deploy-manifest.json`).
  We deliberately do **not** use Amplify's "Custom domain" feature for
  `infuse.bryanharrigan.dev` — see gotcha #6 below for why.
- **Cloudflare Tunnel is gone.** `cloudflared` is no longer needed.

### Files involved

- `amplify.yml` — build spec. Reshapes `build/` into Amplify's
  `.amplify-hosting/` deployment-spec layout.
- `server.js` — Express entrypoint for the SSR Lambda. Loads `.env`
  via `dotenv` (see env-var gotcha below), then mounts Remix's request
  handler.
- `deploy-manifest.json` — tells Amplify how to route traffic
  (`/assets/*` → static, `/*.*` → static, `/*` → compute) and which
  compute resource to invoke (`server.js`, `nodejs20.x`).
- `scripts/cloudflare-worker-amplify-proxy.js` — source for the
  `infuse-origin-proxy` Cloudflare Worker that fronts Amplify on
  `infuse.bryanharrigan.dev`. Edited in the Cloudflare dashboard but
  versioned here so the canonical copy is in git.
- `AWS_MIGRATION.md` — step-by-step playbook used during the migration.
- `env.production.example` — reference template for env vars.

### Critical gotchas (in order they ate hours)

1. **Platform must be WEB_COMPUTE, not WEB.** Amplify's "Host web app"
   default creates the app as `platform: WEB` (static-only). SSR routes
   404 because no Lambda is provisioned. The console can't change this
   after creation:
   ```bash
   aws amplify update-app --app-id <id> --platform WEB_COMPUTE \
     --region us-east-1
   ```

2. **`deploy-manifest.json` layout is precise.** Amplify expects
   exactly this structure:
   ```
   .amplify-hosting/
     ├── deploy-manifest.json
     ├── static/                  (Remix's build/client/)
     └── compute/default/
         ├── server.js            (Express entrypoint)
         ├── server/              (Remix's build/server/)
         ├── package.json
         ├── package-lock.json
         ├── .env                 (baked at build time — see #4)
         └── node_modules/        (production-only)
   ```
   `amplify.yml` does the reshape after `npm run build`.

3. **Framework version must follow strict semver.** In
   `deploy-manifest.json`, `framework.version: "2.10"` is rejected;
   must be `"2.10.3"` (major.minor.patch).

4. **Env vars set in the Amplify console DO NOT propagate to the SSR
   Lambda runtime.** They're available to the BUILD phase as bash
   `$VAR` but not at runtime — every `process.env.X` reads as
   `undefined`. Workaround in `amplify.yml`:
   ```yaml
   - |
     cat > .amplify-hosting/compute/default/.env <<EOF
     COOKIE_SECRET=${COOKIE_SECRET}
     INFUSE_API_KEY=${INFUSE_API_KEY}
     ... etc ...
     EOF
   ```
   And `server.js` calls `import "dotenv/config"` BEFORE any other
   imports so those env vars are populated when the rest of the bundle
   loads. There's a `/diag`-style probe pattern documented in
   `AWS_MIGRATION.md` for verifying env-var presence in the Lambda.

5. **MUI's published ESM has unsupported directory imports.** When
   Vite externalizes `@mui/material` from the SSR build, the Lambda
   fails at module load with
   `ERR_UNSUPPORTED_DIR_IMPORT` because MUI's `index.js` does
   `import x from './foo'` (no `/index.js`). Fix in `vite.config.ts`:
   ```ts
   ssr: {
     noExternal: [/^@mui\//, /^@emotion\//],
   }
   ```
   Note: the older Remix Compiler option `serverDependenciesToBundle`
   is silently ignored by the Vite plugin — that's why this isn't a
   typical config.

6. **DO NOT use Amplify's "Custom domain" feature for
   `infuse.bryanharrigan.dev`.** Amplify periodically re-provisions the
   CloudFront distribution backing the custom domain (likely tied to ACM
   cert renewal — we never fully pinpointed the trigger). Each rotation
   issues a new CloudFront hostname, queues the old one for teardown,
   and waits for your DNS CNAME to point at the new hostname. Because
   Cloudflare's CNAME still points at the now-defunct old hostname,
   Amplify's wait times out, the new distribution gets torn down, and
   visitors see Cloudflare Error 1016 (Origin DNS error). We hit this
   three times in a few days. The fix is **Option E** (executed
   2026-04-26): bypass Amplify's custom domain entirely and have
   Cloudflare proxy directly to the stable Amplify branch URL via a
   Cloudflare Worker.

   Concretely:
   - Amplify's Custom domains list contains only `amplifyapp.com`
     (the auto-generated branch URL). There is **no** entry for
     `bryanharrigan.dev`.
   - Cloudflare DNS for the `infuse` hostname is a **Worker custom
     domain binding** to `infuse-origin-proxy`, not a CNAME to
     CloudFront.
   - The Worker (`scripts/cloudflare-worker-amplify-proxy.js`) rewrites
     the request URL's hostname to `main.d1htx1hpyczhg6.amplifyapp.com`
     so `fetch()` opens TLS to AWS CloudFront with the correct SNI, and
     overrides the `Host` header so CloudFront routes to the Amplify
     app. Without these rewrites, you get Cloudflare Error 525 (TLS
     handshake failed) because CloudFront has no cert for
     `infuse.bryanharrigan.dev` once the Amplify custom domain is gone.

   If you ever need to re-add an Amplify custom domain (e.g., to use
   Amplify's CDN directly), expect the rotation problem to come back —
   leave the Worker in place as the public-facing path.

7. **OAuth /authorize is on the tenant subdomain, NOT
   `infuse.myabsorb.com`.** See Section 5 — common confusion because
   the OpenAPI spec lists `infuse.myabsorb.com` as the Server.

8. **Basic-auth `/authentication` returns 403 from AWS IPs.** That's
   why we use OAuth — see Section 5.

9. **CloudWatch log groups don't exist if compute hasn't logged yet.**
   The log group `/aws/amplify/{appId}` is lazily created on first
   `PutLogEvents`. If your Lambda crashes before any `console.log`
   fires (e.g., import error during init), CloudWatch shows zero log
   groups. Pattern for debugging startup failures: open Express
   listener FIRST, then load the build inside a try/catch + a `/diag`
   route that exposes the error.

### Required Amplify env vars

Set these in **Amplify Console → Hosting → Environment variables**.
After saving, the next build will write them into the compute bundle's
`.env` file via the workaround above.

| Var                          | Notes                                              |
| ---------------------------- | -------------------------------------------------- |
| `COOKIE_SECRET`              | 32+ random bytes for cookie signing                |
| `INFUSE_API_KEY`             | Admin → Integrations → Infuse API                  |
| `INFUSE_API_URL`             | `https://infuse.myabsorb.com`                      |
| `INFUSE_BASE_URL`            | `https://bryanh.myabsorb.com/api/rest/v2`          |
| `INFUSE_PORTAL_URL`          | `https://bryanh.myabsorb.com`                      |
| `INFUSE_OAUTH_CLIENT_ID`     | Portal Settings → Absorb Infuse Access             |
| `INFUSE_OAUTH_CLIENT_SECRET` | same place                                         |
| `PUBLIC_URL` (optional)      | `https://infuse.bryanharrigan.dev`                 |

⚠️ Do **NOT** set `NODE_ENV=production`. With `NODE_ENV=production`,
`npm ci` skips `devDependencies` (including `@remix-run/dev`), so the
build fails with `remix: command not found`.

### Cloudflare DNS / routing for `infuse.bryanharrigan.dev`

There is no traditional CNAME for the `infuse` hostname. Instead the
Worker is bound directly:

```
infuse.bryanharrigan.dev   Worker → infuse-origin-proxy   (Proxied, orange)
```

Cloudflare displays this in DNS Records as Type "Worker" rather than
"CNAME". To inspect or change it: **Workers & Pages → infuse-origin-proxy
→ Settings → Domains & Routes**. Removing the Worker custom domain or
deleting the Worker takes the site offline — there's no fallback DNS
record to fall back to.

There is **no** ACM validation CNAME (it was orphaned when we deleted
the Amplify custom domain — we removed it). SSL/TLS encryption mode for
the zone is **Full (Strict)** — Cloudflare's edge cert covers
`*.bryanharrigan.dev`, and the Worker→Amplify connection uses Amplify's
`*.amplifyapp.com` cert which is valid against the SNI we send.

If you need to test Worker changes safely before they hit production,
add a temporary Custom domain (e.g. `test.bryanharrigan.dev`) on the
Worker, verify, then remove it. We did this during initial setup.

### Deploys

After initial setup, deploys are just `git push origin main`. Amplify
auto-builds via webhook (~3-5 min). For env-var-only changes, you have
to manually click "Redeploy this version" since Amplify doesn't
auto-rebuild on env-var changes.

---

## 9. Known quirks and gotchas

- **Completed courses are launchable.** `CourseCard` maps
  `Complete`/`Completed` to the button label "Review" and keeps the
  click handler wired up. Earlier versions disabled the button with
  `pointer-events: none` — don't re-introduce that.
- **`.ia-hero` banner is shared between My Courses and Catalog.** The
  Learning Hub has its own `.hub-hero` class with the radnet.com
  home-banner image. Both now get the same banner treatment under
  `body.theme-radnet`, but the rules are duplicated — if you change one,
  check the other.
- **RadNet footer is self-conditional.** `RadnetFooter` returns `null`
  unless `themeVariant === "radnet"`. It's always in the tree (mounted
  from `root.tsx`) but only renders for RadNet users.
- **Header rendering on signin page.** The header and footer are gated
  on `location.pathname !== "/signin"` in `root.tsx`.
- **MUI contained primary button color.** `IA.text` is `#f0f0f5`
  (off-white), not pure white — the "Browse Catalog" CTA on the IA hero
  has an explicit CSS override to force `#ffffff`. RadNet overrides the
  same button to render sky-blue text on a white pill.
- **Rank badge (`.ia-rank-badge__title`)** — uses white text on both
  themes because its gradient background is dark/saturated in both
  (purple IA, blue RadNet).

---

## 10. Theme-specific assets (remote URLs)

RadNet intentionally loads real assets from radnet.com so the mock looks
like the real thing:

- Logo (color, no tagline):
  `https://www.radnet.com/files/corporate/assets/branding/radnet-logo-no-tagline.webp`
- Logo (white with tagline, used in footer):
  `https://www.radnet.com/files/corporate/assets/branding/radnet-tagline-white.webp`
- Home banner image:
  `https://www.radnet.com/files/corporate/assets/home/home-banner-bg.webp`

Each has an SVG fallback inside the component (triggered via `onError`).

Corporate nav links in the two-tier header point at real radnet.com
pages: Solutions, AI, Imaging Centers, Our Services, Who We Serve,
About RadNet, and the Investor Day banner links to
`https://www.radnet.com/investor-day`.

---

## 11. Running the app

### Local

```bash
cd ~/Projects/infuse-local
npm run dev
```

Then open `http://localhost:5173`. Sign-in flow redirects to Absorb's
hosted login page (your IP, allow-listed for OAuth) and then back to
your local app's `/auth/callback`. Make sure `.env` is populated.

### Production

```bash
git push origin main
```

That's it. Amplify webhook → build → SSR Lambda swap. Live in ~3-5 min
at `https://infuse.bryanharrigan.dev`. Watch the build via:

```bash
aws amplify list-jobs --app-id d1htx1hpyczhg6 --branch-name main \
  --region us-east-1 --query 'jobSummaries[0]' --output json
```

If env vars changed (Hosting → Environment variables), you must
manually click "Redeploy this version" or push a no-op commit:

```bash
git commit --allow-empty -m "trigger rebuild"
git push
```

### Type-check

```bash
npx tsc --noEmit
```

There's one known pre-existing TS error in `vite.config.ts`
(`serverDependenciesToBundle` flagged by Remix's Vite plugin types).
Now that the config has been cleaned up to use `ssr.noExternal`
instead, this should be gone — verify after the next pull.

---

## 12. When you (Claude) start a new chat on this project

Useful opening moves:

1. Ask what the user wants to change (feature, theme, API, deployment).
2. Read `app/styles/infuse-academy.css` once (~1700 lines) — most theme
   work happens there.
3. Read `app/routes/learning-hub.tsx`, `app/routes/my-courses.tsx`, and
   `app/routes/catalog.tsx` — these are the three main user-facing pages.
4. Remember the CSS specificity gotcha: RadNet bodies have **both**
   `theme-ia` and `theme-radnet` classes. Any rule scoped to
   `body.theme-ia` alone will also apply to RadNet unless overridden.
5. For any Absorb API change, check `app/.server/infuse-api.ts` first
   and the reference sample at `~/Downloads/absorb-infuse-code-sample - main 7/`
   second.
6. For auth flow changes, edit `app/.server/infuse-oauth.ts`,
   `app/routes/signin.tsx`, and `app/routes/auth.callback.tsx`. The
   OAuth endpoints are on the **tenant subdomain**, not
   `infuse.myabsorb.com`.
7. For deployment / build issues, see Section 8. Most painful
   recurring footguns: `NODE_ENV=production` env var (breaks `npm ci`),
   missing `dotenv/config` import in `server.js` (env vars come back
   undefined). The "wrong CloudFront target" / Cloudflare 1016 outage
   was eliminated by Option E (Section 8, gotcha #6) — if it ever
   resurfaces, somebody re-enabled Amplify's custom domain.
8. The public-facing path goes Cloudflare → Worker
   (`infuse-origin-proxy`) → Amplify branch URL. The Worker source is
   in `scripts/cloudflare-worker-amplify-proxy.js`. If that Worker is
   broken or missing, the site is down. There is no DNS fallback.
9. Never introduce `localhost` as an Absorb OAuth redirect URI without
   first registering it as a separate OAuth client in Absorb admin.
