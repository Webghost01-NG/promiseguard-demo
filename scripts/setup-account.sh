#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
if [[ $# -lt 1 || $# -gt 2 || ( $# -eq 2 && "$2" != '--claim-local' ) ]]; then
  echo 'Usage: bash scripts/setup-account.sh USERNAME [--claim-local]' >&2
  exit 1
fi
read -r -s -p 'Choose a password (at least 12 characters): ' account_password
printf '\n'
read -r -s -p 'Repeat password: ' account_confirmation
printf '\n'
if [[ "$account_password" != "$account_confirmation" ]]; then
  echo 'Passwords do not match. No account was created.' >&2
  exit 1
fi
printf '%s' "$account_password" | ./node_modules/.bin/tsx scripts/create-account.ts "$@"
unset account_password account_confirmation
