// Cloudflare Worker — proxies infuse.bryanharrigan.dev to the Amplify branch URL.
//
// WHY THIS EXISTS
// We don't want to use Amplify's "custom domain" feature because Amplify
// periodically re-provisions its CloudFront distribution (likely tied to ACM
// cert renewal). Each rotation gives us a NEW CloudFront hostname, queues the
// old one for teardown, and waits for our Cloudflare CNAME to point at the
// new hostname. Since we have no way to know it rotated, the wait times out,
// Amplify tears down the new distribution, and the site goes down.
//
// Instead, we point Cloudflare directly at the stable Amplify branch URL
// (main.d1htx1hpyczhg6.amplifyapp.com), which is guaranteed-stable for the
// lifetime of the app. But a plain Cloudflare DNS proxy fails at TLS:
// Cloudflare sends SNI=infuse.bryanharrigan.dev to AWS CloudFront, which
// only has a *.amplifyapp.com cert -> Cloudflare error 525.
//
// This Worker fixes that by rewriting the URL hostname before fetch(). Workers
// fetch() uses the URL's hostname for SNI, so AWS CloudFront sees
// SNI=main.d1htx1hpyczhg6.amplifyapp.com, presents *.amplifyapp.com cert,
// handshake succeeds. We also override the Host header so CloudFront routes
// to the Amplify app correctly.
//
// DEPLOY
// 1. Cloudflare Dashboard -> Workers & Pages -> Create Worker
// 2. Name: infuse-origin-proxy
// 3. Paste this file's contents into the editor (replace all)
// 4. Deploy
// 5. Settings -> Triggers -> Routes -> Add route:
//      Route:   infuse.bryanharrigan.dev/*    (or test.bryanharrigan.dev/* for staging)
//      Zone:    bryanharrigan.dev
//
// VERIFY
//   curl https://infuse.bryanharrigan.dev/healthz
//   expected: {"ok":true,"ts":"..."}

const ORIGIN_HOST = "main.d1htx1hpyczhg6.amplifyapp.com";

export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Rewrite the URL hostname so fetch() opens a TLS connection to AWS
    // CloudFront with SNI = ORIGIN_HOST. Path/query/fragment preserved.
    url.hostname = ORIGIN_HOST;
    // Match Cloudflare's edge port behavior (HTTPS).
    url.protocol = "https:";
    url.port = "";

    // Copy headers and force the Host header to match the new origin so
    // CloudFront routes the request to the right Amplify distribution.
    const headers = new Headers(request.headers);
    headers.set("host", ORIGIN_HOST);

    // Forward the original visitor host so the SSR Lambda can use it for
    // OAuth redirect URIs, canonical URLs, etc. (server.js can read this.)
    const originalHost = request.headers.get("host");
    if (originalHost) headers.set("x-forwarded-host", originalHost);

    const proxied = new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual", // pass redirects through to the visitor (OAuth)
    });

    return fetch(proxied);
  },
};
