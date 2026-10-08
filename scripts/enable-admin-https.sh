#!/usr/bin/env bash
# ======================================================
# Enable HTTPS for admin.animastor.org
#
# Domain migration (2026-10): canonical domain is animastor.org. This script
# issues/renews BOTH Let's Encrypt certificates (webroot authentication):
#
#   1. animastor.org — canonical family:
#      animastor.org www.animastor.org app.animastor.org admin.animastor.org
#   2. animastor.in  — legacy family, kept only to serve the 301 redirect
#      to .org without a TLS error:
#      animastor.in www.animastor.in app.animastor.in admin.animastor.in
#
# It then reloads nginx.
#
# Запуск:  sudo ./scripts/enable-admin-https.sh
# ======================================================

set -euo pipefail

WEBROOT="/home/sureg/animastor/frontends/website"
CERT_NAME_ORG="animastor.org"
CERT_NAME_LEGACY="animastor.in"

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: run with sudo: sudo $0" >&2
    exit 1
fi

if [ ! -d "$WEBROOT" ]; then
    echo "ERROR: webroot not found: $WEBROOT" >&2
    exit 1
fi

echo "==> Pre-flight: ACME challenge path must be reachable"
mkdir -p "$WEBROOT/.well-known/acme-challenge"
echo acme-preflight-ok > "$WEBROOT/.well-known/acme-challenge/preflight.txt"
PREFLIGHT=$(curl -s --resolve admin.animastor.org:80:127.0.0.1 http://admin.animastor.org/.well-known/acme-challenge/preflight.txt || true)
rm -f "$WEBROOT/.well-known/acme-challenge/preflight.txt"
if [ "$PREFLIGHT" != "acme-preflight-ok" ]; then
    echo "ERROR: ACME challenge path not served (got: '$PREFLIGHT'). Is animastor-proxy running?" >&2
    exit 1
fi
echo "    OK"

echo "==> Issuing canonical certificate for: animastor.org www.animastor.org app.animastor.org admin.animastor.org"
certbot certonly --webroot -w "$WEBROOT" --cert-name "$CERT_NAME_ORG" \
    -d animastor.org -d www.animastor.org -d app.animastor.org -d admin.animastor.org \
    --non-interactive --agree-tos

echo "==> Issuing legacy (redirect-only) certificate for: animastor.in www.animastor.in app.animastor.in admin.animastor.in"
certbot certonly --webroot -w "$WEBROOT" --cert-name "$CERT_NAME_LEGACY" \
    -d animastor.in -d www.animastor.in -d app.animastor.in -d admin.animastor.in \
    --non-interactive --agree-tos

echo "==> Reloading nginx (docker)"
docker exec animastor-proxy nginx -s reload
sleep 2

echo "==> Verifying served certificates"
SERVED_SAN_ORG=$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.animastor.org 2>/dev/null | openssl x509 -noout -ext subjectAltName)
echo "$SERVED_SAN_ORG"

if echo "$SERVED_SAN_ORG" | grep -q "admin.animastor.org"; then
    echo "==> PASS: admin.animastor.org is in the served certificate"
else
    echo "==> FAIL: admin.animastor.org NOT in the served certificate" >&2
    exit 1
fi

SERVED_SAN_LEGACY=$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.animastor.in 2>/dev/null | openssl x509 -noout -ext subjectAltName)
echo "$SERVED_SAN_LEGACY"

if echo "$SERVED_SAN_LEGACY" | grep -q "admin.animastor.in"; then
    echo "==> PASS: admin.animastor.in is in the legacy redirect certificate"
else
    echo "==> FAIL: admin.animastor.in NOT in the legacy redirect certificate" >&2
    exit 1
fi
