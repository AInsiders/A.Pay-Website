# Deploy all Teller-related Edge Functions with JWT verification disabled at the API gateway.
# ES256 session JWTs require this; functions still authenticate via getUser() inside the handler.
# Requires: Supabase CLI (`npm i -g supabase` or scoop/choco), and `supabase link` from repo root.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$functions = @(
  "teller-nonce",
  "teller-enrollment-complete",
  "teller-data",
  "teller-webhook"
)

foreach ($name in $functions) {
  Write-Host "Deploying $name..." -ForegroundColor Cyan
  supabase functions deploy $name --no-verify-jwt
}

Write-Host "Done. In Dashboard -> Edge Functions, confirm Verify JWT is off for each function." -ForegroundColor Green
