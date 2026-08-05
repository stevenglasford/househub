#!/bin/sh
# Generate the server's root secret. Append the output to your .env:
#
#   ./scripts/generate-secret.sh >> .env
#
# This seals email addresses, TOTP secrets, calendar URLs and wallet config.
# It does NOT protect household content -- that is encrypted under each member's
# own password and this server never holds a key for it. Back it up anyway:
# without it, those server-side values are unrecoverable.
set -eu
if command -v openssl >/dev/null 2>&1; then
  printf 'SECRET_KEY=%s\n' "$(openssl rand -base64 32)"
elif command -v node >/dev/null 2>&1; then
  node -e "console.log('SECRET_KEY=' + require('crypto').randomBytes(32).toString('base64'))"
else
  printf 'SECRET_KEY=%s\n' "$(head -c 32 /dev/urandom | base64)"
fi
