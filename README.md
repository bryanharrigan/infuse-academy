# Infuse Local

A self-contained Remix app for your Absorb Infuse LMS, running locally over
HTTPS with OAuth 2.0 authentication. Designed to run identically on your
laptop and on a Linux VM / EC2 instance — the only thing that changes
between environments is the `.env` file.

---

## What's in here

```
infuse-local/
├── app/                         Remix application
│   ├── .server/                 Server-only code
│   │   ├── infuse-api.ts        Absorb REST API client
│   │   └── oauth.server.ts      OAuth 2.0 + PKCE helpers
│   ├── constants/
│   │   └── infuse-cookie.server.ts  Signed HttpOnly session cookies
│   ├── routes/
│   │   ├── _index.tsx           Home page (after login)
│   │   ├── signin.tsx           Redirects to Absorb OAuth login
│   │   ├── signout.tsx          Revokes token + clears cookies
│   │   ├── auth.callback.tsx    OAuth redirect target
│   │   ├── my-courses.tsx       User's enrolled courses
│   │   ├── catalog.tsx          Browse + enroll in courses
│   │   ├── course-player.$courseId.tsx
│   │   └── lesson-player.$courseId.tsx
│   ├── components/              UI components (MUI-based)
│   ├── root.tsx                 Layout + transparent token refresh
│   └── ...
├── certs/                       Your local HTTPS certs (gitignored)
├── scripts/
│   ├── bootstrap.sh             One-time local setup
│   └── setup-cert.sh            Install Cloudflare or self-signed cert
├── .env.example                 Template for your real .env
├── package.json
├── vite.config.ts               Reads certs/ automatically for HTTPS
└── README.md
```

---

## Quick start

### 1. One-time setup

```bash
cd infuse-local
chmod +x scripts/*.sh
./scripts/bootstrap.sh
```

This will:
- Verify Node 20+ is installed
- Add `bryanh.localhost` to `/etc/hosts`
- Install dependencies
- Create `.env` from `.env.example` (with a real COOKIE_SECRET generated)

### 2. Set up HTTPS

```bash
./scripts/setup-cert.sh
```

Pick option **1** if you have a Cloudflare-hosted domain (recommended — same
cert works in prod), or option **2** for a self-signed cert (simplest).

### 3. Fill in `.env`

Open `.env` and fill in these values from your Absorb portal:

```bash
INFUSE_API_KEY=...                 # Admin → Integrations → Infuse API
OAUTH_CLIENT_ID=...                # Admin → OAuth Clients → your client
OAUTH_CLIENT_SECRET=...            # ditto
```

The defaults for the other variables (base URL, redirect URI, scopes) are
already set for `bryanh.myabsorb.com` + `bryanh.localhost:5173`.

### 4. Register the redirect URI in Absorb

In your Absorb OAuth client settings, the Redirect URI must **exactly** be:

```
https://bryanh.localhost:5173/auth/callback
```

### 5. Run

```bash
npm run dev
```

Open https://bryanh.localhost:5173 — you'll be redirected to the Absorb
login page, then back to the app fully authenticated.

---

## OAuth flow

```
Browser  ──► /signin
              │  Generate state + PKCE verifier, store in cookie
              ▼  Redirect
         bryanh.myabsorb.com/oauth2/authorize
              │  User logs in on Absorb's page
              ▼  Redirect back
         /auth/callback?code=XXX&state=YYY
              │  Validate state (CSRF check)
              │  POST /oauth2/token  (code + verifier → tokens)
              │  Store tokens in HttpOnly cookie
              ▼  Redirect
            /  (home page, logged in)
```

When the access token expires, the root loader silently refreshes it using
the refresh token. The user never sees a re-login prompt unless they've been
inactive for 8+ hours.

---

## Security properties

| Property | How it's enforced |
|----------|-------------------|
| Password never touches our app | OAuth — user logs in on Absorb's page |
| API key not in source | `.env` + gitignored + `process.env` lookups |
| CSRF protection | Random `state` param validated at callback |
| Code interception protection | PKCE with S256 challenge |
| Token stored safely | HttpOnly + Secure + SameSite=Lax signed cookie |
| No stale tokens | Server-side revocation on sign-out |
| Transparent refresh | Root loader refreshes before expiry |

---

## Deploying to a Linux VM or AWS later

Because all secrets live in `.env` and the cert lives in `./certs/`, moving
this project to any Linux host is almost a direct copy:

1. `rsync` or `scp` the project to your server
2. Install Node 20 + run `npm install && npm run build`
3. Create a production `.env` on the server — change:
   - `NODE_ENV=production`
   - `OAUTH_REDIRECT_URI=https://yourdomain.com/auth/callback`
   - Point `certs/` at your production Cloudflare cert (or use nginx with Let's Encrypt)
4. Update the redirect URI in the Absorb OAuth client to match the server URL
5. Run `npm start` under a process manager like `pm2`

No code changes needed.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| Browser shows cert warning | Expected with self-signed — click Advanced → Proceed, or trust the cert in Keychain |
| `ECONNREFUSED` loading page | Nothing is running — start `npm run dev` |
| Redirect loop to /signin | Check `COOKIE_SECRET` in `.env`, and that `OAUTH_REDIRECT_URI` matches the Absorb registration exactly |
| "state_mismatch" on callback | Took longer than 10 min to log in, or cookies blocked — try again |
| "token_exchange_failed" | `OAUTH_REDIRECT_URI` doesn't match Absorb, or client secret is wrong |
| "INFUSE_API_KEY not set" in logs | `.env` didn't load — make sure you're running from project root |

---

## License

MIT
