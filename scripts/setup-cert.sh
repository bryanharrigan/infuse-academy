#!/usr/bin/env bash
# =============================================================================
# setup-cert.sh — Set up HTTPS certificates for local development
#
# Two modes:
#   1. CLOUDFLARE ORIGIN CERT (recommended if you have a Cloudflare domain)
#      — Trusted by Cloudflare when proxying through them
#      — Valid for up to 15 years
#      — The SAME cert works locally AND on your deployed server
#
#   2. SELF-SIGNED (fallback for pure local testing)
#      — Browser will show a warning you'll need to bypass once
#      — Simplest option; no Cloudflare account required
# =============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$PROJECT_ROOT/certs"

mkdir -p "$CERT_DIR"

cat <<'EOF'

╔══════════════════════════════════════════════════════════════╗
║                    HTTPS Certificate Setup                     ║
╚══════════════════════════════════════════════════════════════╝

Choose your cert strategy:

  1) Cloudflare Origin Certificate  (best for prod parity)
  2) Self-signed cert                (simplest for local-only)
  3) Skip — I already have certs in ./certs/

EOF

read -p "Choose [1-3]: " CHOICE

case "$CHOICE" in

  # ─── CLOUDFLARE ORIGIN CERT ─────────────────────────────────────────────────
  1)
    cat <<'EOF'

┌───────────────────────────────────────────────────────────────┐
│   Cloudflare Origin Certificate — manual steps                │
└───────────────────────────────────────────────────────────────┘

This gives you one cert that's trusted by Cloudflare for a domain
under your account. Use it locally via /etc/hosts, and again on
your server when you deploy.

1. Log into https://dash.cloudflare.com
2. Pick your domain
3. Go to SSL/TLS → Origin Server → "Create Certificate"
4. Defaults are fine:
   • Generate private key and CSR with Cloudflare
   • RSA (2048-bit)
   • Hostnames: *.yourdomain.com, yourdomain.com
   • Validity: 15 years
5. Click "Create"
6. Copy the "Origin Certificate" block — including the
   BEGIN/END CERTIFICATE lines
7. Paste it here when prompted, then press Ctrl-D on an empty line

EOF
    read -p "Press Enter when you're ready to paste the CERTIFICATE..."
    echo "Paste the certificate now, then Ctrl-D when done:"
    cat > "$CERT_DIR/cert.pem"
    echo ""
    echo "✅ Saved certificate to certs/cert.pem"
    echo ""

    cat <<'EOF'
8. Now go back to Cloudflare and copy the "Private Key" block
9. Paste it here, then Ctrl-D on an empty line
EOF
    read -p "Press Enter when you're ready to paste the PRIVATE KEY..."
    echo "Paste the private key now, then Ctrl-D when done:"
    cat > "$CERT_DIR/key.pem"
    echo ""
    echo "✅ Saved private key to certs/key.pem"

    chmod 600 "$CERT_DIR/key.pem"
    chmod 644 "$CERT_DIR/cert.pem"
    ;;

  # ─── SELF-SIGNED ────────────────────────────────────────────────────────────
  2)
    echo ""
    echo "Generating self-signed cert for bryanh.localhost..."
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
      -keyout "$CERT_DIR/key.pem" \
      -out "$CERT_DIR/cert.pem" \
      -subj "/CN=bryanh.localhost" \
      -addext "subjectAltName=DNS:bryanh.localhost,DNS:localhost,IP:127.0.0.1" \
      2>/dev/null

    chmod 600 "$CERT_DIR/key.pem"
    chmod 644 "$CERT_DIR/cert.pem"
    echo "✅ Self-signed cert generated"
    echo ""
    echo "ℹ️  Your browser will show a warning the first time you visit."
    echo "   Click 'Advanced' → 'Proceed to bryanh.localhost (unsafe)'"
    echo ""
    echo "To make the warning go away, trust the cert in Keychain:"
    echo "   sudo security add-trusted-cert -d -r trustRoot \\"
    echo "     -k /Library/Keychains/System.keychain \\"
    echo "     $CERT_DIR/cert.pem"
    ;;

  # ─── SKIP ───────────────────────────────────────────────────────────────────
  3)
    if [ ! -f "$CERT_DIR/cert.pem" ] || [ ! -f "$CERT_DIR/key.pem" ]; then
      echo "❌ No certs found in $CERT_DIR — expected cert.pem + key.pem"
      exit 1
    fi
    echo "✅ Using existing certs at $CERT_DIR/"
    ;;

  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Cert setup complete"
echo ""
echo "   Cert:  $CERT_DIR/cert.pem"
echo "   Key:   $CERT_DIR/key.pem"
echo ""
echo "Next: npm run dev"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
