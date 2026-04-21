# Smoke-test CORS preflight for Teller Edge Functions (no JWT required for OPTIONS in most setups).
# Usage from repo root (PowerShell):
#   $env:VITE_SUPABASE_URL = "https://YOUR_REF.supabase.co"
#   .\scripts\smoke-teller-edge-cors.ps1
# Optional:
#   .\scripts\smoke-teller-edge-cors.ps1 -Origin "https://ainsiders.github.io"
param(
  [string]$SupabaseUrl = $env:VITE_SUPABASE_URL,
  [string]$Origin = "https://ainsiders.github.io"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $SupabaseUrl?.Trim()) {
  Write-Error "Set VITE_SUPABASE_URL or pass -SupabaseUrl (e.g. https://xxxxx.supabase.co)"
}

$base = $SupabaseUrl.TrimEnd("/")
$names = @("teller-enrollment-complete", "teller-nonce", "teller-data")

foreach ($slug in $names) {
  $uri = "$base/functions/v1/$slug"
  Write-Host "`n=== OPTIONS $slug ===" -ForegroundColor Cyan
  try {
    $resp = Invoke-WebRequest -Uri $uri -Method OPTIONS -Headers @{
      "Origin"                         = $Origin
      "Access-Control-Request-Method"  = "POST"
      "Access-Control-Request-Headers" = "authorization,apikey,content-type"
    } -SkipHttpErrorCheck -UseBasicParsing
    Write-Host "HTTP $($resp.StatusCode)"
    $ac = $resp.Headers["Access-Control-Allow-Origin"]
    Write-Host "Access-Control-Allow-Origin: $(if ($ac) { $ac } else { '(missing)' })"
    if (-not $ac) {
      Write-Host "Interpretation: response did not include ACAO — often the API gateway rejected the request before your function (e.g. verify_jwt / wrong slug). Redeploy with --no-verify-jwt and confirm the function exists." -ForegroundColor Yellow
    } elseif ($ac -eq "*" -or $ac -eq $Origin) {
      Write-Host "CORS preflight looks OK for this origin." -ForegroundColor Green
    }
  } catch {
    Write-Host "Request failed: $_" -ForegroundColor Red
  }
}

Write-Host "`nDone. Compare URL host to the one in bank-portal/.env (VITE_SUPABASE_URL)." -ForegroundColor Gray
