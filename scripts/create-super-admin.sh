#!/bin/sh
# Promote an existing account to super-admin.
#
# There is no bootstrap super-admin and no default password: sign up through the
# web UI like anyone else, then run this once against the database.
#
#   ./scripts/create-super-admin.sh you@example.com
#
# A super-admin operates the server. They cannot read any household -- they hold
# no household key, and no endpoint exists that would give them one.
set -eu
[ $# -eq 1 ] || { echo "usage: $0 <email>" >&2; exit 1; }
exec node "$(dirname "$0")/../server/scripts/create-super-admin.js" "$1"
