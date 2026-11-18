<#
.SYNOPSIS
    Adds the LTI environment variables to the Infuse service and restarts it.

.DESCRIPTION
    Runs on the ORIGIN machine (DESKTOP-HGPP7U3), ELEVATED.

    The Infuse service's environment lives in NSSM's AppEnvironmentExtra, in
    the registry under the service. remix-serve does not read .env files and
    C:\Infuse\.env.production is dormant, so this is the only place runtime
    config actually comes from.

    That makes this script destructive if it goes wrong: AppEnvironmentExtra
    is set as a whole, so a careless write drops COOKIE_SECRET and the entire
    OAuth config and every sign-in on the site breaks. So it:

      - reads the current value first and writes it to a timestamped backup
        OUTSIDE the repo, before changing anything
      - MERGES rather than replaces, keeping every variable it did not set
      - shows you a masked before/after and does nothing without -Apply
      - restarts with sc.exe stop/start, because nssm restart fails on this
        machine (nssm 2.24-101)
      - health-checks the result and tells you how to roll back

    It never deletes or re-registers the service.

.PARAMETER EnvFile
    A plain text file of KEY=VALUE lines holding the secrets -- the output of
    `node scripts/lti-keygen.mjs`. Keep it outside the repo and delete it
    afterwards (-RemoveEnvFile does that for you).

.PARAMETER Apply
    Actually write. Without it the script is a dry run.

.PARAMETER RemoveEnvFile
    Delete the EnvFile after a successful apply.

.PARAMETER Restore
    Path to a backup file written by an earlier run. Restores that exact
    environment and restarts. Use if something has gone wrong.

.EXAMPLE
    # 1. See what would change
    .\scripts\lti-setup-origin.ps1 -EnvFile C:\Users\Bryan\lti-secrets.txt

.EXAMPLE
    # 2. Do it
    .\scripts\lti-setup-origin.ps1 -EnvFile C:\Users\Bryan\lti-secrets.txt -Apply -RemoveEnvFile

.EXAMPLE
    # Roll back
    .\scripts\lti-setup-origin.ps1 -Restore C:\ProgramData\Infuse\env-backups\Infuse-env-20261118-143012.txt
#>

[CmdletBinding()]
param(
    [string]$EnvFile,
    [switch]$Apply,
    [switch]$RemoveEnvFile,
    [string]$Restore
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'Infuse'
$BackupDir   = Join-Path $env:ProgramData 'Infuse\env-backups'
$HealthUrl   = 'http://127.0.0.1:3000/lti/jwks'

function Write-Step  ([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    ([string]$m) { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2 ([string]$m) { Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err2  ([string]$m) { Write-Host "    $m" -ForegroundColor Red }

# Non-secret values. Visible on purpose: you should be able to read this file
# and know exactly what will be set. Secrets come from -EnvFile only.
$Defaults = [ordered]@{
    'PUBLIC_URL'          = 'https://infuse.bryanharrigan.dev'
    'LTI_TOOL_KID'        = 'infuse-lti-1'
    'LTI_SOURCE_REST_URL' = 'https://rest.myabsorb.com'
    'LTI_PLATFORMS'       = '[{"id":"bharrigan","issuer":"https://bharrigan.myabsorb.ca","clientId":"c52d9197-dfa2-42f3-8280-3d0cf007d94a","deploymentIds":["infuse-bharrigan-1"],"authUrl":"https://bharrigan.myabsorb.ca/lti-tool/authenticate","tokenUrl":"https://bharrigan.myabsorb.ca/lti-tool/token","jwksUrl":"https://bharrigan.myabsorb.ca/lti-tool/jwks"}]'
}

# Masked in all output. Everything else is printed in full so the diff is real.
$SecretKeys = @(
    'LTI_TOOL_PRIVATE_KEY'
    'LTI_PROVISION_SECRET'
    'LTI_WEBHOOK_SECRET'
    'COOKIE_SECRET'
    'INFUSE_API_KEY'
    'LTI_SOURCE_API_KEY'
    'INFUSE_OAUTH_CLIENT_SECRET'
    'BHARRIGAN_OAUTH_CLIENT_SECRET'
    'EMBED_SERVICE_PASSWORD'
)

function Format-Value ([string]$key, [string]$value) {
    if ($SecretKeys -contains $key) {
        if ([string]::IsNullOrEmpty($value)) { return '<empty>' }
        return ('<{0} chars>' -f $value.Length)
    }
    if ($value.Length -gt 90) { return $value.Substring(0, 87) + '...' }
    return $value
}

function Assert-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Err2 "This needs an ELEVATED PowerShell."
        Write-Err2 "sc.exe stop will say access denied otherwise."
        Write-Err2 "Right-click PowerShell -> Run as administrator, then rerun."
        exit 1
    }
}

function Find-Nssm {
    $candidates = @(
        'C:\Windows\System32\NSSM\nssm.exe'
        'C:\Windows\System32\nssm.exe'
        'C:\nssm\nssm.exe'
    )
    foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
    $onPath = Get-Command nssm.exe -ErrorAction SilentlyContinue
    if ($onPath) { return $onPath.Source }
    Write-Err2 "Could not find nssm.exe. Looked in:"
    $candidates | ForEach-Object { Write-Err2 "      $_" }
    exit 1
}

# NSSM writes UTF-16. Without this the value comes back with NUL bytes between
# every character and the parse silently produces nonsense.
function Get-ServiceEnvironment ([string]$nssm) {
    $prev = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = [System.Text.Encoding]::Unicode
        $raw = & $nssm get $ServiceName AppEnvironmentExtra 2>&1
    } finally {
        [Console]::OutputEncoding = $prev
    }

    $vars = [ordered]@{}
    foreach ($line in @($raw)) {
        $s = ([string]$line).Trim([char]0, ' ', "`t", "`r", "`n")
        if ([string]::IsNullOrWhiteSpace($s)) { continue }
        $i = $s.IndexOf('=')
        # Split on the FIRST '=' only: base64 values are full of them.
        if ($i -lt 1) { continue }
        $vars[$s.Substring(0, $i)] = $s.Substring($i + 1)
    }
    return $vars
}

function Read-EnvFile ([string]$path, [switch]$Lenient) {
    if (-not (Test-Path $path)) {
        Write-Err2 "EnvFile not found: $path"
        exit 1
    }
    $full = (Resolve-Path $path).Path
    if ($full -like '*\infuse-academy\*' -or $full -like 'C:\Infuse\*') {
        Write-Err2 "That file is inside a repo checkout. Move it out first --"
        Write-Err2 "the repo is public and this file holds your signing key."
        exit 1
    }

    $vars = [ordered]@{}
    foreach ($line in (Get-Content -LiteralPath $full)) {
        $s = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($s)) { continue }
        if ($s.StartsWith('#')) { continue }
        # Ignore the keygen script's explanatory prose and rule lines.
        if ($s.StartsWith('-----')) { continue }
        $i = $s.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $s.Substring(0, $i).Trim()
        # Strict by default so the keygen script's prose (e.g. "kty=RSA  e=AQAB")
        # is ignored. Lenient for restores, where dropping a variable because of
        # its casing would quietly lose part of the environment.
        $pattern = if ($Lenient) { '^[A-Za-z_][A-Za-z0-9_]*$' } else { '^[A-Z][A-Z0-9_]*$' }
        if ($k -notmatch $pattern) { continue }
        $vars[$k] = $s.Substring($i + 1)
    }
    if ($vars.Count -eq 0) {
        Write-Err2 "No KEY=VALUE lines found in $full"
        exit 1
    }
    return $vars
}

function Backup-Environment ([System.Collections.Specialized.OrderedDictionary]$vars) {
    if (-not (Test-Path $BackupDir)) {
        New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $path = Join-Path $BackupDir "$ServiceName-env-$stamp.txt"
    $lines = foreach ($k in $vars.Keys) { "$k=$($vars[$k])" }
    # ASCII: the values are all ASCII, and a BOM here would corrupt a restore.
    Set-Content -LiteralPath $path -Value $lines -Encoding ASCII
    return $path
}

function Set-ServiceEnvironment ([string]$nssm, [System.Collections.Specialized.OrderedDictionary]$vars) {
    # Not $args -- that is an automatic variable and assigning to it is asking
    # for trouble under StrictMode.
    $pairs = foreach ($k in $vars.Keys) { "$k=$($vars[$k])" }
    & $nssm set $ServiceName AppEnvironmentExtra @pairs
    if ($LASTEXITCODE -ne 0) { throw "nssm set failed with exit code $LASTEXITCODE" }
}

function Restart-InfuseService {
    # nssm restart fails on this machine (nssm 2.24-101). sc.exe works.
    Write-Host "    sc.exe stop $ServiceName"
    & sc.exe stop $ServiceName | Out-Null
    $svc = Get-Service -Name $ServiceName
    try { $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30)) }
    catch { Write-Warn2 "Did not reach Stopped within 30s; continuing." }

    Start-Sleep -Seconds 2

    Write-Host "    sc.exe start $ServiceName"
    & sc.exe start $ServiceName | Out-Null
    $svc = Get-Service -Name $ServiceName
    try { $svc.WaitForStatus('Running', (New-TimeSpan -Seconds 45)) }
    catch { throw "Service did not reach Running within 45s." }
}

function Test-Health {
    # Give remix-serve a moment to bind before asking it anything.
    for ($i = 1; $i -le 10; $i++) {
        Start-Sleep -Seconds 3
        try {
            $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 10
            if ($r.StatusCode -eq 200 -and $r.Content -match '"kid"') {
                return @{ ok = $true; detail = $r.Content.Substring(0, [Math]::Min(160, $r.Content.Length)) }
            }
            return @{ ok = $false; detail = "HTTP $($r.StatusCode) but no kid in the body: $($r.Content.Substring(0, [Math]::Min(200, $r.Content.Length)))" }
        } catch {
            $msg = $_.Exception.Message
            if ($i -eq 10) { return @{ ok = $false; detail = $msg } }
        }
    }
    return @{ ok = $false; detail = 'timed out' }
}

# ------------------------------- main -------------------------------

Assert-Elevated
$nssm = Find-Nssm
Write-Step "Service"
Write-Ok "nssm:    $nssm"
Write-Ok "service: $ServiceName"

Write-Step "Reading current environment"
$current = Get-ServiceEnvironment $nssm
Write-Ok "$($current.Count) variable(s) currently set"
if ($current.Count -eq 0) {
    Write-Warn2 "That is unexpected -- this service should already have COOKIE_SECRET,"
    Write-Warn2 "INFUSE_API_KEY and more. If nssm returned nothing, STOP and check"
    Write-Warn2 "'$nssm get $ServiceName AppEnvironmentExtra' by hand before continuing."
    if (-not $Apply) { Write-Warn2 "(dry run, so nothing is at risk yet)" }
    else {
        Write-Err2 "Refusing to write over an environment I could not read."
        exit 1
    }
}

$backupPath = Backup-Environment $current
Write-Ok "backup: $backupPath"

# -- Restore mode ----------------------------------------------------
if ($Restore) {
    Write-Step "Restoring from $Restore"
    $restored = Read-EnvFile $Restore -Lenient
    Write-Ok "$($restored.Count) variable(s) to restore"
    if (-not $Apply) {
        Write-Warn2 "Dry run. Rerun with -Apply to actually restore."
        exit 0
    }
    Set-ServiceEnvironment $nssm $restored
    Restart-InfuseService
    $h = Test-Health
    if ($h.ok) { Write-Ok "Restored and healthy." } else { Write-Err2 "Restored but health check failed: $($h.detail)" }
    exit 0
}

# -- Build the desired environment -----------------------------------
if (-not $EnvFile) {
    Write-Err2 "-EnvFile is required. Generate it first:"
    Write-Err2 "    node scripts\lti-keygen.mjs > `$env:USERPROFILE\lti-secrets.txt"
    Write-Err2 "then trim it to just the KEY=VALUE lines, or pass the whole file --"
    Write-Err2 "the prose lines are ignored."
    exit 1
}

Write-Step "Reading secrets"
$secrets = Read-EnvFile $EnvFile
Write-Ok "$($secrets.Count) variable(s) from $EnvFile"

$required = @('LTI_TOOL_PRIVATE_KEY', 'LTI_PROVISION_SECRET')
$absent = $required | Where-Object { -not $secrets.Contains($_) }
if ($absent) {
    Write-Err2 "EnvFile is missing: $($absent -join ', ')"
    Write-Err2 "Run 'node scripts\lti-keygen.mjs' and use its output."
    exit 1
}

$desired = [ordered]@{}
foreach ($k in $current.Keys)  { $desired[$k] = $current[$k] }
foreach ($k in $Defaults.Keys) { $desired[$k] = $Defaults[$k] }
foreach ($k in $secrets.Keys)  { $desired[$k] = $secrets[$k] }

# A value containing a space or a double quote does not survive native
# argument passing reliably on Windows PowerShell. None of ours should.
$awkward = @()
foreach ($k in $desired.Keys) {
    if ($desired[$k] -match '[\s"]') { $awkward += $k }
}
if ($awkward.Count -gt 0) {
    Write-Warn2 "These values contain spaces or quotes and may not survive nssm set:"
    $awkward | ForEach-Object { Write-Warn2 "      $_" }
    Write-Warn2 "If one of them breaks, set it by hand with 'nssm edit $ServiceName'."
}

Write-Step "Changes"
$added = 0; $changed = 0; $kept = 0
foreach ($k in $desired.Keys) {
    if (-not $current.Contains($k)) {
        Write-Host ("    + {0,-24} {1}" -f $k, (Format-Value $k $desired[$k])) -ForegroundColor Green
        $added++
    } elseif ($current[$k] -ne $desired[$k]) {
        Write-Host ("    ~ {0,-24} {1}" -f $k, (Format-Value $k $current[$k])) -ForegroundColor DarkYellow
        Write-Host ("      {0,-24} {1}" -f '->', (Format-Value $k $desired[$k])) -ForegroundColor Yellow
        $changed++
    } else {
        $kept++
    }
}
Write-Host ""
Write-Ok "$added added, $changed changed, $kept unchanged (total $($desired.Count))"

if (-not $Apply) {
    Write-Host ""
    Write-Warn2 "DRY RUN -- nothing has been written."
    Write-Warn2 "Rerun with -Apply to make these changes."
    exit 0
}

Write-Step "Writing environment"
try {
    Set-ServiceEnvironment $nssm $desired
    Write-Ok "written"
} catch {
    Write-Err2 "nssm set failed: $($_.Exception.Message)"
    Write-Err2 "Restore with:"
    Write-Err2 "    .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}

Write-Step "Restarting $ServiceName"
try {
    Restart-InfuseService
    Write-Ok "running"
} catch {
    Write-Err2 $_.Exception.Message
    Write-Err2 "Restore with:"
    Write-Err2 "    .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}

Write-Step "Health check"
$health = Test-Health
if ($health.ok) {
    Write-Ok "GET /lti/jwks returned a keyset:"
    Write-Host "      $($health.detail)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Ok "Confirm the kid reads infuse-lti-1 -- that is the value the host portal will look for."
} else {
    Write-Err2 "Health check failed: $($health.detail)"
    Write-Err2 ""
    Write-Err2 "Most likely causes, in order:"
    Write-Err2 "  1. LTI_TOOL_PRIVATE_KEY lost its \n escapes -> /lti/jwks 500s"
    Write-Err2 "  2. The new code is not deployed yet -> /lti/jwks 404s."
    Write-Err2 "     Check: sc.exe query infuse-deploy, and git log in C:\Infuse"
    Write-Err2 "  3. The service did not come back cleanly"
    Write-Err2 ""
    Write-Err2 "Roll back if needed:"
    Write-Err2 "    .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}

if ($RemoveEnvFile) {
    Remove-Item -LiteralPath (Resolve-Path $EnvFile).Path -Force
    Write-Ok "deleted $EnvFile"
} else {
    Write-Host ""
    Write-Warn2 "Delete $EnvFile when you are done -- it holds your signing key."
}

$__msg = @"

Done. Last step is in the host portal:

  bharrigan.myabsorb.ca -> Client Settings -> LTI Registration
    open "Infuse Cross-Portal Player" and set Status to ACTIVE

Then add it to a course as an LTI Learning Object. The course is pinned via
Custom Fields, so no content picker is involved in this first run.

Backup of the previous environment:
  $backupPath

"@
Write-Host $__msg -ForegroundColor DarkGray
