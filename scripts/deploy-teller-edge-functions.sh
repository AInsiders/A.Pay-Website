#!/usr/bin/env bash
# Deploy all Teller-related Edge Functions with JWT verification disabled at the API gateway.
# ES256 session JWTs require this; functions still authenticate via getUser() inside the handler.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

for name in teller-nonce teller-enrollment-complete teller-data teller-webhook; do
  echo "Deploying ${name}..."
  supabase functions deploy "$name" --no-verify-jwt
done

echo "Done. In Dashboard -> Edge Functions, confirm Verify JWT is off for each function."
