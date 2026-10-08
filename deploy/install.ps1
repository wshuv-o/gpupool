# Join this Windows PC to the GPU pool at https://gpu.odinbd.com
#
#   $env:GPU_KEY='ek_...'; $env:GPU_LABEL='gpu-1'; irm https://gpu.odinbd.com/install.ps1 | iex
#
# Safe to run again: it updates the code, re-registers this PC and restarts the agent.
$ErrorActionPreference = 'Stop'
$Root  = 'https://gpu.odinbd.com'
$Key   = $env:GPU_KEY
$Label = if ($env:GPU_LABEL) { $env:GPU_LABEL } else { $env:COMPUTERNAME }

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`nSTOPPED: $m" -ForegroundColor Red; throw $m }

if (-not $Key -or -not $Key.StartsWith('ek_')) {
  Fail "Set your setup key first:  `$env:GPU_KEY='ek_...'  (ask the pool owner; it is on the dashboard)"
}

Step 'Checking Node.js and Git'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js is not installed. Run:  winget install OpenJS.NodeJS.LTS   then open a NEW PowerShell and run this again.' }
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 20) { Fail "Node $major is too old (need 20+). Run:  winget install OpenJS.NodeJS.LTS   then open a NEW PowerShell." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'Git is not installed. Run:  winget install Git.Git   then open a NEW PowerShell and run this again.' }
Write-Host "    node $(node -v), $(git --version)"

Step 'Checking Ollama'
function Test-Ollama { try { $null = Invoke-RestMethod 'http://localhost:11434/api/tags' -TimeoutSec 4; $true } catch { $false } }
if (-not (Test-Ollama)) {
  if (Get-Command ollama -ErrorAction SilentlyContinue) {
    Write-Host '    Ollama is installed but not answering. Starting it...'
    Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden
    for ($i = 0; $i -lt 20 -and -not (Test-Ollama); $i++) { Start-Sleep 1 }
  }
}
if (-not (Test-Ollama)) {
  Fail 'No AI server answering on http://localhost:11434. Install Ollama (winget install Ollama.Ollama), run:  ollama pull llama3.2:3b   then run this again.'
}
$models = (Invoke-RestMethod 'http://localhost:11434/api/tags').models
if (-not $models -or $models.Count -eq 0) { Fail 'Ollama is running but has no models. Run:  ollama pull llama3.2:3b   then run this again.' }
Write-Host "    Ollama OK, $($models.Count) model(s): $(($models | ForEach-Object { $_.name }) -join ', ')"

Step 'Getting the agent'
$Code = Join-Path $env:USERPROFILE 'gpupool-agent'
$Run  = Join-Path $env:USERPROFILE '.gpupool'      # working folder: holds this PC's manifest, never the repo's sample
if (Test-Path (Join-Path $Code '.git')) { git -C $Code pull --ff-only --quiet } else { git clone --quiet https://github.com/wshuv-o/gpupool.git $Code }
if ($LASTEXITCODE -ne 0) { Fail 'Could not download or update the agent from GitHub. Check your internet connection and try again.' }
Push-Location $Code
try {
  & npm.cmd ci --silent
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci failed (see above).' }
  & npm.cmd run build --silent
  if ($LASTEXITCODE -ne 0) { Fail 'Build failed (see above).' }
} finally { Pop-Location }
New-Item -ItemType Directory -Force $Run | Out-Null
$Agent = Join-Path $Code 'dist\agent\index.js'
if (-not (Test-Path $Agent)) { Fail 'Build failed: dist\agent\index.js is missing. Scroll up for the npm error.' }

Step "Joining the pool as '$Label'"
Push-Location $Run
try {
  # A stale manifest from an earlier attempt would be kept as-is by setup, so start clean.
  Remove-Item (Join-Path $Run 'gpupool.yaml') -ErrorAction SilentlyContinue
  try { node $Agent service uninstall 2>$null | Out-Null } catch { }
  node $Agent setup leaf --key $Key --root $Root --label $Label
  if ($LASTEXITCODE -ne 0) { Fail 'Joining failed. The message above says why (wrong key, enrollment closed, or no AI server found).' }
  $y = Get-Content (Join-Path $Run 'gpupool.yaml') -Raw
  if ($y -notmatch '(?m)^\s*ollama:') { Fail "The manifest does not name the 'ollama' environment, so requests would not reach this PC.`n$y" }

  Step 'Keeping it running'
  node $Agent service install
  if ($LASTEXITCODE -ne 0) { Fail 'service install failed (see above).' }
  schtasks /run /tn gpupool-agent | Out-Null
} finally { Pop-Location }

Start-Sleep 5
Write-Host "`nDONE. '$Label' joined the pool and starts again at every logon." -ForegroundColor Green
Write-Host "Check it: $Root/_ui  (green dot and your models)."
