#!/usr/bin/env bash
# =============================================================================
# bootstrap.sh — One-time setup on a fresh Mac / Linux box
#
# Run this ONCE after cloning the project. It:
#   1. Verifies Node.js 20+ is installed
#   2. Adds `bryanh.localhost` to /etc/hosts (if missing)
#   3. Installs npm dependencies
#   4. Copies .env.example → .env (if .env doesn't already exist)
#   5. Reminds you to set up your Cloudflare Origin Certificate
#
# Safe to re-run — each step checks if it's already been done.
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

echo "🌱 Bootstrapping Infuse Local at: $PROJECT_ROOT"
echo ""

# ─── 1. Check Node.js version ─────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is not installed."
  echo "   Install Node 20+ from https://nodejs.org or via Homebrew:"
  echo "      brew install node@20"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "❌ Node.js is $(node -v), but we need v20 or later."
  exit 1
fi
echo "✅ Node.js $(node -v)"

# ─── 2. /etc/hosts entry ──────────────────────────────────────────────────────
HOST_ENTRY="127.0.0.1 bryanh.localhost"
if grep -qE "^\s*127\.0\.0\.1\s+bryanh\.localhost\b" /etc/hosts; then
  echo "✅ /etc/hosts already has bryanh.localhost"
else
  echo "➕ Adding 'bryanh.localhost' to /etc/hosts (requires sudo)..."
  echo "$HOST_ENTRY" | sudo tee -a /etc/hosts >/dev/null
  echo "✅ Added: $HOST_ENTRY"
fi

# ─── 3. Install dependencies ──────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  echo "📦 Installing npm dependencies (this may take a minute)..."
  npm install
else
  echo "✅ node_modules already exists — run 'npm install' manually if you need a refresh"
fi

# ─── 4. Create .env if needed ─────────────────────────────────────────────────
if [ ! -f ".env" ]; then
  cp .env.example .env
  # Generate a real cookie secret into the new .env
  COOKIE_SECRET=$(openssl rand -base64 48 | tr -d '\n')
  # macOS sed needs -i '' ; GNU sed needs -i
  if [[ "$OSTYPE" == "darwin"* ]]; then
    sed -i '' "s|COOKIE_SECRET=change_me_to_a_long_random_string|COOKIE_SECRET=${COOKIE_SECRET}|" .env
  else
    sed -i "s|COOKIE_SECRET=change_me_to_a_long_random_string|COOKIE_SECRET=${COOKIE_SECRET}|" .env
  fi
  echo "✅ Created .env from .env.example (with a generated COOKIE_SECRET)"
  echo "   👉 Edit .env now and fill in: INFUSE_API_KEY, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET"
else
  echo "✅ .env already exists — leaving it untouched"
fi

# ─── 5. Check for certs ───────────────────────────────────────────────────────
if [ -f "certs/cert.pem" ] && [ -f "certs/key.pem" ]; then
  echo "✅ HTTPS certs found in ./certs/"
else
  echo ""
  echo "⚠️  No HTTPS cert found at certs/cert.pem + certs/key.pem"
  echo "   Run ./scripts/setup-cert.sh for options (Cloudflare Origin Cert or self-signed)"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Bootstrap complete"
echo ""
echo "Next steps:"
echo "  1. Edit .env and fill in INFUSE_API_KEY + OAUTH credentials"
echo "  2. Run ./scripts/setup-cert.sh to set up HTTPS"
echo "  3. Start the dev server:  npm run dev"
echo "  4. Visit:  https://bryanh.localhost:5173"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
