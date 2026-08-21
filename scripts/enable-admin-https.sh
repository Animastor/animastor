#!/usr/bin/env bash
# ======================================================
# Enable HTTPS for admin.animastor.in
#
# Расширяет существующий сертификат animastor.in (Let's Encrypt,
# webroot-автентификация — тот же механизм, что уже используется)
# добавлением SAN admin.animastor.in и перезагружает nginx.
#
# Запуск:  sudo ./scripts/enable-admin-https.sh
# ======================================================

set -euo pipefail

WEBROOT="/home/sureg/animastor/frontends/website"
CERT_NAME="animastor.in"

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
PREFLIGHT=$(curl -s --resolve admin.animastor.in:80:127.0.0.1 http://admin.animastor.in/.well-known/acme-challenge/preflight.txt || true)
rm -f "$WEBROOT/.well-known/acme-challenge/preflight.txt"
if [ "$PREFLIGHT" != "acme-preflight-ok" ]; then
    echo "ERROR: ACME challenge path not served (got: '$PREFLIGHT'). Is animastor-proxy running?" >&2
    exit 1
fi
echo "    OK"

echo "==> Issuing certificate for: animastor.in www.animastor.in app.animastor.in admin.animastor.in"
certbot certonly --webroot -w "$WEBROOT" --cert-name "$CERT_NAME" -d animastor.in -d www.animastor.in -d app.animastor.in -d admin.animastor.in --non-interactive --agree-tos

echo "==> Reloading nginx (docker)"
docker exec animastor-proxy nginx -s reload
sleep 2

echo "==> Verifying served certificate"
SERVED_SAN=$(echo | openssl s_client -connect 127.0.0.1:443 -servername admin.animastor.in 2>/dev/null | openssl x509 -noout -ext subjectAltName)
echo "$SERVED_SAN"

if echo "$SERVED_SAN" | grep -q "admin.animastor.in"; then
    echo "==> PASS: admin.animastor.in is in the served certificate"
else
    echo "==> FAIL: admin.animastor.in NOT in the served certificate" >&2
    exit 1
fi
