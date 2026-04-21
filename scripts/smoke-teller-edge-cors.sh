#!/usr/bin/env bash
# Smoke-test CORS preflight for Teller Edge Functions.
# Usage:
#   export VITE_SUPABASE_URL="https://YOUR_REF.supabase.co"
#   ./scripts/smoke-teller-edge-cors.sh
# Optional first arg: Origin (default https://ainsiders.github.io)
set -euo pipefail
BASE="${VITE_SUPABASE_URL:-}"
ORIGIN="${1:-https://ainsiders.github.io}"
if [[ -z "${BASE}" ]]; then
  echo "Set VITE_SUPABASE_URL first" >&2
  exit 1
fi
BASE="${BASE%/}"
for slug in teller-enrollment-complete teller-nonce teller-data; do
  echo ""
  echo "=== OPTIONS ${slug} ==="
  curl -sS -D - -o /dev/null -X OPTIONS \
    -H "Origin: ${ORIGIN}" \
    -H "Access-Control-Request-Method: POST" \
    -H "Access-Control-Request-Headers: authorization,apikey,content-type" \
    "${BASE}/functions/v1/${slug}" | head -n 25
done
echo ""
echo "Look for Access-Control-Allow-Origin in the response headers."
