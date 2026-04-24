# Infuse Academy / RadNet LMS — AWS Amplify Migration Guide

Step-by-step guide for porting `infuse-local` from a Cloudflare-tunnel-to-localhost
dev setup to **AWS Amplify Hosting** while keeping `infuse.bryanharrigan.dev` as
the public origin (required for Absorb's allow-list).

---

## Target architecture

```
Browser ──HTTPS──> Cloudflare edge (orange cloud, proxied)
                   │  TLS terminates, WAF + caching
                   ▼
                   CNAME: infuse.bryanharrigan.dev ──> <app-id>.amplifyapp.com
                                                      │
                                                      ▼
                                              AWS Amplify Hosting
                                              (Remix SSR + static assets)
                                                      │
                                                      ▼ (server-side fetch)
                                              Absorb Infuse API
                                              (infuseapi.myabsorb.com + bryanh.myabsorb.com)
```

Key properties:

- **Browser** always sees `https://infuse.bryanharrigan.dev` — no change from
  what Absorb has on its allow-list.
- **Cloudflare** stays in front, provides edge TLS, DDoS, WAF, caching.
- **Amplify** hosts the built Remix app; ACM issues an origin cert so
  Cloudflare can use "Full (Strict)" SSL mode.
- **Cloudflare Tunnel is gone.** `cloudflared` is no longer needed.

---

## Pre-migration checklist

Before touching AWS, do these in the existing repo:

1. **Commit everything and push to a Git host.** Amplify connects to GitHub,
   GitLab, Bitbucket, or CodeCommit. GitHub is easiest.
2. **Verify the build works locally:**
   ```bash
   npm run build
   # Should produce build/client/ and build/server/
   ```
3. **Inventory your environment variables.** List every `process.env.*`
   reference in `app/.server/` — these need to be recreated in Amplify.
   Likely suspects:
   - Absorb API base URLs (if not hardcoded)
   - JWT cookie secret / signing key
   - Any API keys (if Absorb requires a non-user credential anywhere)
4. **Note the Cloudflare zone** (`bryanharrigan.dev`) and confirm you have
   admin access to add DNS records.

---

## Step 1 — Drop `amplify.yml` into the repo

Copy `amplify.yml` (in this package) to the repo root. Commit and push to
your main branch. This file tells Amplify how to build the project — use
Node 20, run `npm ci` + `npm run build`, and publish the `build/` output.

If your repo's default branch is not `main`, no change needed — Amplify
lets you pick the branch when you connect the repo.

---

## Step 2 — Create the Amplify app

1. Sign in to the AWS console → **AWS Amplify** → **Create new app**.
2. Pick **Host web app**.
3. Choose your Git provider (GitHub etc.) and authorize Amplify.
4. Select the `infuse-local` repo and the branch (`main`).
5. **Framework detection:** Amplify should auto-detect Remix. If it doesn't,
   pick "Remix" manually. It will show a proposed `amplify.yml`; override it
   with the file from this package (or confirm that yours is being used).
6. **App settings:**
   - App name: `infuse-academy` (or whatever you want)
   - Environment name: `main`
   - Service role: let Amplify create one, or reuse an existing
     `amplifyconsole-backend-role` with SSR permissions.
7. Click through to **Save and deploy**. First deploy takes ~5–8 minutes.

When it finishes, Amplify gives you a URL like
`https://main.d2xyz123abc.amplifyapp.com`. Open it — you should see the app
running. The domain is wrong (Absorb will reject requests), but the
server is up.

---

## Step 3 — Configure environment variables

Amplify console → **your app** → **Hosting** → **Environment variables**.

Add every variable your server code reads. At minimum:

| Variable | Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Standard |
| `INFUSE_API_HOST` | `https://infuseapi.myabsorb.com` | If referenced as env var |
| `TENANT_HOST` | `https://bryanh.myabsorb.com` | If referenced as env var |
| `COOKIE_SECRET` | `<generate 32+ random bytes>` | For `infuseJwtCookie` signing |

Generate a cookie secret:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

**Important:** after adding or changing env vars, trigger a redeploy —
Amplify bakes them into the build.

---

## Step 4 — Custom domain (the tricky part)

You want `https://infuse.bryanharrigan.dev` → Amplify, with Cloudflare
in front as a proxy.

**Do NOT use Amplify's "Add domain" flow the normal way.** That flow
assumes Route 53 or a registrar that points NS records at AWS. Since
`bryanharrigan.dev` is on Cloudflare, you're going to do the verification
manually.

### 4a. Start the domain add flow in Amplify

1. Amplify console → your app → **Hosting** → **Custom domains** → **Add domain**.
2. Enter `bryanharrigan.dev` as the root domain. Amplify will offer
   `www` and apex subdomains — remove those and add **only**
   `infuse.bryanharrigan.dev`.
3. Amplify will show you:
   - An **ACM certificate validation record** (CNAME — something like
     `_abc123.infuse.bryanharrigan.dev` → `_xyz.acm-validations.aws`)
   - A **domain target** (CNAME — `infuse.bryanharrigan.dev` →
     `<amplify-branch>.<app-id>.amplifyapp.com` or a CloudFront distribution).
4. **Leave this tab open.** You need both records in Cloudflare before
   Amplify's verification can finish.

### 4b. Add records in Cloudflare

Cloudflare dashboard → `bryanharrigan.dev` zone → **DNS** → **Records** →
**Add record** (twice):

**Record 1 — ACM validation:**
- Type: `CNAME`
- Name: `_abc123.infuse` *(just the part before `.bryanharrigan.dev`)*
- Target: the `_xyz.acm-validations.aws` value Amplify gave you
- Proxy status: **DNS only** (grey cloud — MUST be grey for ACM to validate)
- TTL: Auto

**Record 2 — the app itself:**
- Type: `CNAME`
- Name: `infuse`
- Target: the Amplify domain (`main.d2xyz123abc.amplifyapp.com` or similar)
- Proxy status: **Proxied** (orange cloud)
- TTL: Auto

Save both.

### 4c. Wait for Amplify

Back in Amplify — the domain status will cycle through **Pending verification**
→ **Creating SSL certificate** → **Configuring** → **Available**. This can
take 15–45 minutes. If it's stuck on verification past an hour, double-check
the ACM record is grey-clouded (not proxied) in Cloudflare.

### 4d. Set Cloudflare SSL mode to Full (Strict)

Cloudflare dashboard → `bryanharrigan.dev` → **SSL/TLS** → **Overview**.

Set encryption mode to **Full (strict)**. This makes Cloudflare validate
Amplify's ACM cert when proxying. Anything less (Flexible, Full non-strict)
is insecure or broken.

---

## Step 5 — Verify end-to-end

```bash
curl -I https://infuse.bryanharrigan.dev
# Expect: HTTP/2 200, server: cloudflare
```

Open `https://infuse.bryanharrigan.dev` in a browser:

1. It should load the Remix app (landing page or signin, depending on auth
   state).
2. Sign in with Absorb credentials — if Absorb responds, the allow-list is
   still happy.
3. Navigate to Learning Hub, My Courses, Catalog — all SSR loaders should
   fetch successfully.
4. Open a lesson player — the iframe from `bryanh.myabsorb.com` should load
   (this is client-side, unrelated to AWS, but worth confirming).

If you get Absorb errors about origin/referer, the allow-list entry isn't
matching — check that the browser's URL bar shows `infuse.bryanharrigan.dev`
and not the raw Amplify URL.

---

## Step 6 — Retire the Cloudflare Tunnel

Once the Amplify deploy is verified working:

1. Stop the `cloudflared` daemon on your laptop.
2. Cloudflare Zero Trust dashboard → **Networks** → **Tunnels** → delete
   the `infuse-local` tunnel.
3. The Cloudflare DNS record for `infuse` is now the Amplify CNAME (step
   4b), not the tunnel — nothing more to change.

---

## What happens to the dev setup

The `vite.config.ts` workarounds (HTTP/2 pseudo-header stripping, forced
HTTP/1.1, self-signed certs) are **dev-only** and don't affect production.
Keep them in `vite.config.ts` for local development.

For local dev going forward, you have two options:

**Option A: Keep the Cloudflare Tunnel for local dev.**
Same as before, but maybe point it at a different subdomain like
`dev-infuse.bryanharrigan.dev` so prod (`infuse.*`) stays stable. You'd
need to add that subdomain to Absorb's allow-list.

**Option B: Use Amplify preview branches.**
Push a feature branch, Amplify auto-deploys it to a branch URL. Point a
subdomain at it the same way as step 4. Heavier but no local tunnel needed.

---

## Ongoing deploys

After initial setup, deploys are just `git push`:

```bash
git push origin main
# Amplify webhook fires, build starts, ~3-5 min later it's live.
```

Amplify keeps the previous version warm and swaps atomically.

---

## Cost estimate

For a low-traffic testbed LMS:

| Service | Monthly estimate |
|---|---|
| Amplify Hosting (SSR, ~5 GB transfer, minimal compute) | $1–5 |
| ACM certificate | Free |
| Cloudflare (existing free plan) | $0 |
| **Total** | **~$1–5/mo** |

Amplify charges per build-minute, per GB served, and per SSR compute-second.
A testbed rarely crosses the $5/mo mark. If traffic grows substantially,
App Runner or ECS Fargate becomes more cost-predictable.

---

## Rollback plan

If something breaks in Amplify:

1. Cloudflare DNS → change the `infuse` CNAME proxy status to DNS-only
   and point it back at a Cloudflare Tunnel (if you kept one running) or
   just flip the CNAME target.
2. Amplify deployments can be rolled back instantly — console → **Hosting**
   → **Deployments** → pick a previous successful build → **Redeploy this
   version**.

---

## Gotchas specific to this app

- **MUI/Emotion SSR cache.** `entry.server.tsx` and `entry.client.tsx` use
  Emotion cache hydration. Amplify's SSR adapter runs the same Node handler
  you'd run anywhere, so this works unchanged — but verify the Emotion
  cache insertion point renders correctly after first deploy (view page
  source, confirm `<style data-emotion="...">` tags are present in the
  `<head>`).
- **Absorb allow-list is origin-sensitive, not just host-sensitive.** Some
  Absorb endpoints check `Origin` / `Referer` headers. Since Cloudflare
  preserves these when proxying, you should be fine — but if you see
  intermittent 403s from Absorb, check your Cloudflare **Transform Rules**
  aren't rewriting headers.
- **Remote radnet.com assets.** The RadNet theme loads logos and banners
  from `www.radnet.com`. These are client-side fetches, no change. If
  radnet.com ever blocks hotlinking, the SVG fallbacks in each component
  take over.
- **HttpOnly JWT cookie domain.** The `infuseJwtCookie` should have
  `domain: "infuse.bryanharrigan.dev"` (or omitted — default is the
  request host). Don't hardcode `localhost` anywhere.
- **There's a known pre-existing TS error in `vite.config.ts`**
  (`serverDependenciesToBundle` typing). Amplify's build runs
  `npm run build`, not `tsc`, so this won't fail the build — but if you
  add `tsc --noEmit` to your build script, it will. Keep it out of the
  build command.
