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
    signin.tsx                # Absorb sign-in form → JWT cookie
    signout.tsx
    learning-hub.tsx          # Sana-style dashboard (primary homepage)
    my-courses.tsx            # Enrolled-courses grid + gamification
    catalog.tsx               # All available courses + search
    course-player.$courseId.tsx   # Route alternative to modal
    lesson-player.$courseId.tsx   # Route alternative to modal
    use-my-courses.hook.ts
    use-catalog.hook.ts

  styles/
    infuse-academy.css        # ~1700 lines of theme CSS (IA + RadNet)

  tailwind.css
  root.tsx                    # Document shell, theme switch, auth loader
  entry.client.tsx            # Emotion cache hydration
  entry.server.tsx            # SSR entry

vite.config.ts                # HTTPS certs, HTTP/1.1 forced, allowedHosts
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

### Auth — what we actually do

1. User posts credentials to `/api/rest/v2/authentication/tokens` on
   the tenant host. Response is a JWT.
2. JWT is stored in an HttpOnly cookie via `infuseJwtCookie` (see
   `app/constants/infuse-cookie.server.ts`).
3. That JWT is used as `Authorization: Bearer <jwt>` for subsequent
   Infuse API calls.

We deliberately do **not** run the full OAuth/admin authorization flow —
the tenant JWT alone is enough for the endpoints we need.

### Endpoints we use

| Purpose               | Method / Path                                               |
| --------------------- | ----------------------------------------------------------- |
| Auth                  | `POST /api/rest/v2/authentication/tokens` (tenant)          |
| Profile               | `GET /api/rest/v2/users/me` (Infuse API)                    |
| Avatar                | `GET /api/rest/v2/users/me/avatar` (Infuse API)             |
| My courses            | `GET /my-courses?limit=30&showCompleted=true` (Infuse API)  |
| Catalog               | `GET /my-catalog?limit=30&showCompleted=true` (Infuse API)  |
| Enroll                | `POST /enrollments` with `{courseId}` (Infuse API)          |
| Enrollment status     | `GET /my-courses/{id}/enrollment` (Infuse API)              |
| Course chapters       | `GET /online-courses/{id}/chapters` (Infuse API)            |
| News                  | `GET /my-news-articles` (Infuse API)                        |
| Lesson player URL     | `{tenant}/learn/lessonplayer?lessonId={id}` (NOT the API)   |

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
- **Verifier** (for the lesson player) is hardcoded; OAuth dance is not
  required for our use case.

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

## 7. Local dev setup

### Cloudflare tunnel (the critical piece)

Absorb has an **allow list** — its UI/API calls only succeed when the
request Origin / Referer comes from a domain Absorb trusts. localhost is
not on that list. So we route dev traffic through a Cloudflare Tunnel:

```
infuse.bryanharrigan.dev   ──(Cloudflare edge)──>   cloudflared daemon   ──>   localhost:5173
```

The tunnel is **network-agnostic** — it's an outbound connection from
the laptop to Cloudflare, so moving WiFi networks doesn't require any
reconfig. Just start `cloudflared tunnel run <name>` and `npm run dev`,
then open `https://infuse.bryanharrigan.dev`.

### Vite config highlights (`vite.config.ts`)

- `host: "0.0.0.0"` — listen on all interfaces (needed for tunnel).
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
- Local HTTPS via self-signed certs in `./certs/` (optional — falls
  through to HTTP when absent).

### Allow-list reminders

- Production allow-list entry: `infuse.bryanharrigan.dev`.
- Raw LAN IPs and `localhost` will fail against Absorb.

---

## 8. Known quirks and gotchas

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

## 9. Theme-specific assets (remote URLs)

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

## 10. Running the app

```bash
# Start the tunnel (in a dedicated terminal or as a service)
cloudflared tunnel run <tunnel-name>

# Start Vite (in another terminal)
cd ~/Projects/infuse-local
npm run dev
```

Open `https://infuse.bryanharrigan.dev` in a browser.

Type-check:

```bash
npx tsc --noEmit
```

There is one known pre-existing TS error in `vite.config.ts`
(`serverDependenciesToBundle` flagged by Remix's Vite plugin types) that
can be ignored — it's a type-level noise, not a runtime issue.

---

## 11. When you (Claude) start a new chat on this project

Useful opening moves:

1. Ask what the user wants to change (feature, theme, API).
2. Read `app/styles/infuse-academy.css` once (~1700 lines) — most theme
   work happens there.
3. Read `app/routes/learning-hub.tsx`, `app/routes/my-courses.tsx`, and
   `app/routes/catalog.tsx` — these are the three main user-facing pages.
4. Remember the specificity gotcha: RadNet bodies have **both**
   `theme-ia` and `theme-radnet` classes. Any rule scoped to
   `body.theme-ia` alone will also apply to RadNet unless overridden.
5. For any Absorb API change, check `app/.server/infuse-api.ts` first
   and the reference sample at `~/Downloads/absorb-infuse-code-sample - main 7/`
   second.
6. Never introduce `localhost` as an Absorb-facing URL — it will fail
   the allow-list. Use the tunnel domain.
