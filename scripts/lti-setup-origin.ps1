<#
.SYNOPSIS
    Adds the LTI environment variables to the Infuse service and restarts it.

.DESCRIPTION
    Runs on the ORIGIN machine (DESKTOP-HGPP7U3), ELEVATED.

    The Infuse service's environment lives in NSSM's AppEnvironmentExtra.
    remix-serve does not read .env files and C:\Infuse\.env.production is
    dormant, so this is the only source of runtime config. Setting it wrong
    drops COOKIE_SECRET and the whole OAuth config, and every sign-in on the
    site breaks.

    THIS VERSION READS AND WRITES THE REGISTRY DIRECTLY rather than going
    through nssm.exe. The CLI route was replaced after it returned an empty
    environment on this machine on 18 Nov 2026 -- nssm emits UTF-16 and the
    decode is fragile, the nssm in PATH here is a WinGet shim rather than the
    System32 build the project notes describe, and several of our values
    contain spaces and double quotes which do not survive native argument
    passing reliably. AppEnvironmentExtra is a plain REG_MULTI_SZ, so the
    registry avoids every one of those problems.

      HKLM:\SYSTEM\CurrentControlSet\Services\Infuse\Parameters
        AppEnvironmentExtra   REG_MULTI_SZ   one KEY=VALUE per entry

    Safety: it refuses to write over an environment it could not read, backs
    up to a timestamped file outside the repo first, MERGES rather than
    replaces, does nothing without -Apply, reads back what it wrote to confirm
    it landed, and never deletes or re-registers the service.

.PARAMETER EnvFile
    Plain text KEY=VALUE lines holding the secrets -- the output of
    `node scripts/lti-keygen.mjs`. Keep it outside the repo.

.PARAMETER Apply
    Actually write. Without it this is a dry run.

.PARAMETER RemoveEnvFile
    Delete the EnvFile after a successful apply.

.PARAMETER Restore
    Path to a backup written by an earlier run. Restores it verbatim.

.PARAMETER ShowCurrent
    Print the current environment (secrets masked) and exit. Use this to
    diagnose a read problem without touching anything.

.EXAMPLE
    .\scripts\lti-setup-origin.ps1 -ShowCurrent

.EXAMPLE
    .\scripts\lti-setup-origin.ps1 -EnvFile "$env:USERPROFILE\lti-secrets.txt"

.EXAMPLE
    .\scripts\lti-setup-origin.ps1 -EnvFile "$env:USERPROFILE\lti-secrets.txt" -Apply -RemoveEnvFile
#>

[CmdletBinding()]
param(
    [string]$EnvFile,
    [switch]$Apply,
    [switch]$RemoveEnvFile,
    [string]$Restore,
    [switch]$ShowCurrent
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ServiceName = 'Infuse'
$ParamsKey   = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName\Parameters"
$BackupDir   = Join-Path $env:ProgramData 'Infuse\env-backups'
$HealthUrl   = 'http://127.0.0.1:3000/lti/jwks'

function Write-Step  ([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    ([string]$m) { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2 ([string]$m) { Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err2  ([string]$m) { Write-Host "    $m" -ForegroundColor Red }

# Non-secret values, visible on purpose: you should be able to read this file
# and know exactly what will be set. Secrets come from -EnvFile only.
$Defaults = [ordered]@{
    'PUBLIC_URL'          = 'https://infuse.bryanharrigan.dev'
    'LTI_TOOL_KID'        = 'infuse-lti-1'
    'LTI_SOURCE_REST_URL' = 'https://rest.myabsorb.com'
    'LTI_PLATFORMS'       = '[{"id":"bharrigan","issuer":"https://bharrigan.myabsorb.ca","clientId":"c52d9197-dfa2-42f3-8280-3d0cf007d94a","deploymentIds":["infuse-bharrigan-1"],"authUrl":"https://bharrigan.myabsorb.ca/lti-tool/authenticate","tokenUrl":"https://bharrigan.myabsorb.ca/lti-tool/token","jwksUrl":"https://bharrigan.myabsorb.ca/lti-tool/jwks"}]'
}

# Which variables this script may introduce. Anything else in the EnvFile is
# ignored -- the keygen script prints explanatory prose alongside its output,
# and a stray line should never become an environment variable.
#
# Any LTI_* or SMOWL_* name is allowed so new settings can be added without
# editing this script, plus the non-LTI defaults below.
function Test-AllowedKey ([string]$key) {
    if ($key -cmatch '^LTI_[A-Z0-9_]+$')   { return $true }
    if ($key -cmatch '^SMOWL_[A-Z0-9_]+$') { return $true }
    return @($Defaults.Keys) -contains $key
}

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

function Test-SecretKey ([string]$key) {
    if ($SecretKeys -contains $key) { return $true }
    # Case-insensitive on purpose: catch every spelling of a secret-ish name.
    return $key -match '(_SECRET|_KEY|_PASSWORD|_PASS|_TOKEN|_PRIVATE)$'
}

function Format-Value ([string]$key, [string]$value) {
    if (Test-SecretKey $key) {
        if ([string]::IsNullOrEmpty($value)) { return '<empty>' }
        return ('<{0} chars>' -f $value.Length)
    }
    if ($value.Length -gt 80) { return $value.Substring(0, 77) + '...' }
    return $value
}

function Assert-Elevated {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Write-Err2 "This needs an ELEVATED PowerShell (it writes HKLM and restarts a service)."
        exit 1
    }
}

function ConvertTo-EnvMap ([string[]]$lines) {
    $vars = [ordered]@{}
    foreach ($line in @($lines)) {
        if ($null -eq $line) { continue }
        $s = ([string]$line).Trim([char]0, ' ', "`t", "`r", "`n")
        if ([string]::IsNullOrWhiteSpace($s)) { continue }
        # First '=' only: base64 and JSON values are full of them.
        $i = $s.IndexOf('=')
        if ($i -lt 1) { continue }
        $vars[$s.Substring(0, $i)] = $s.Substring($i + 1)
    }
    return $vars
}

function Get-RegistryEnvironment ([string]$valueName) {
    if (-not (Test-Path $ParamsKey)) {
        Write-Err2 "Registry key not found: $ParamsKey"
        Write-Err2 "Is the service really called '$ServiceName'?"
        exit 1
    }
    $props = Get-ItemProperty -Path $ParamsKey -ErrorAction SilentlyContinue
    if ($null -eq $props -or -not ($props.PSObject.Properties.Name -contains $valueName)) {
        return [ordered]@{}
    }
    return (ConvertTo-EnvMap ([string[]]$props.$valueName))
}

function Set-RegistryEnvironment ([System.Collections.Specialized.OrderedDictionary]$vars) {
    $multi = [string[]](@(foreach ($k in $vars.Keys) { "$k=$($vars[$k])" }))
    # REG_MULTI_SZ: no quoting, no encoding negotiation, no argument parsing.
    Set-ItemProperty -Path $ParamsKey -Name 'AppEnvironmentExtra' -Value $multi -Type MultiString
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
        if ($s.StartsWith('-----')) { continue }
        $i = $s.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $s.Substring(0, $i).Trim()
        # -cnotmatch, NOT -notmatch: PowerShell's -match is case-INSENSITIVE,
        # so the case-insensitive version let the keygen script's self-check
        # line ("kty=RSA  e=AQAB ...") through as a variable named 'kty'.
        $pattern = if ($Lenient) { '^[A-Za-z_][A-Za-z0-9_]*$' } else { '^[A-Z][A-Z0-9_]*$' }
        if ($k -cnotmatch $pattern) { continue }
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
    Set-Content -LiteralPath $path -Value $lines -Encoding ASCII
    return $path
}

function Restart-InfuseService {
    # nssm restart fails on this machine (nssm 2.24-101). sc.exe works.
    Write-Host "    sc.exe stop $ServiceName"
    & sc.exe stop $ServiceName | Out-Null
    try { (Get-Service -Name $ServiceName).WaitForStatus('Stopped', (New-TimeSpan -Seconds 30)) }
    catch { Write-Warn2 "Did not reach Stopped within 30s; continuing." }

    Start-Sleep -Seconds 2

    Write-Host "    sc.exe start $ServiceName"
    & sc.exe start $ServiceName | Out-Null
    try { (Get-Service -Name $ServiceName).WaitForStatus('Running', (New-TimeSpan -Seconds 45)) }
    catch { throw "Service did not reach Running within 45s." }
}

function Test-Health {
    for ($i = 1; $i -le 10; $i++) {
        Start-Sleep -Seconds 3
        try {
            $r = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 10
            if ($r.StatusCode -eq 200 -and $r.Content -match '"kid"') {
                return @{ ok = $true; detail = $r.Content.Substring(0, [Math]::Min(160, $r.Content.Length)) }
            }
            return @{ ok = $false; detail = "HTTP $($r.StatusCode), no kid in body" }
        } catch {
            if ($i -eq 10) { return @{ ok = $false; detail = $_.Exception.Message } }
        }
    }
    return @{ ok = $false; detail = 'timed out' }
}

# ------------------------------- main -------------------------------

Assert-Elevated

Write-Step "Service"
Write-Ok "registry: $ParamsKey"

Write-Step "Reading current environment (registry)"
$current = Get-RegistryEnvironment 'AppEnvironmentExtra'
$alsoAppEnv = Get-RegistryEnvironment 'AppEnvironment'
Write-Ok "AppEnvironmentExtra: $($current.Count) variable(s)"
Write-Ok "AppEnvironment:      $($alsoAppEnv.Count) variable(s)"

if ($ShowCurrent) {
    Write-Step "AppEnvironmentExtra"
    foreach ($k in $current.Keys) { Write-Host ("    {0,-30} {1}" -f $k, (Format-Value $k $current[$k])) }
    if ($alsoAppEnv.Count -gt 0) {
        Write-Step "AppEnvironment"
        foreach ($k in $alsoAppEnv.Keys) { Write-Host ("    {0,-30} {1}" -f $k, (Format-Value $k $alsoAppEnv[$k])) }
    }
    exit 0
}

if ($current.Count -eq 0 -and -not $Restore) {
    Write-Err2 "AppEnvironmentExtra is empty."
    Write-Err2 ""
    Write-Err2 "This service should already hold COOKIE_SECRET, INFUSE_API_KEY and more."
    Write-Err2 "Writing now would REPLACE the environment with only the LTI variables"
    Write-Err2 "and break every sign-in on the site, so this script stops here."
    Write-Err2 ""
    Write-Err2 "Check by hand before doing anything else:"
    Write-Err2 "    Get-ItemProperty -Path '$ParamsKey' | Format-List"
    if ($alsoAppEnv.Count -gt 0) {
        Write-Err2 ""
        Write-Err2 "NOTE: AppEnvironment holds $($alsoAppEnv.Count) variable(s). If the service's"
        Write-Err2 "config lives there rather than in AppEnvironmentExtra, say so and the"
        Write-Err2 "script can target that value instead."
    }
    exit 1
}

$backupPath = Backup-Environment $current
Write-Ok "backup: $backupPath"

# -- Restore mode --
if ($Restore) {
    Write-Step "Restoring from $Restore"
    $restored = Read-EnvFile $Restore -Lenient
    Write-Ok "$($restored.Count) variable(s) to restore"
    if (-not $Apply) { Write-Warn2 "Dry run. Rerun with -Apply to actually restore."; exit 0 }
    Set-RegistryEnvironment $restored
    Restart-InfuseService
    $h = Test-Health
    if ($h.ok) { Write-Ok "Restored and healthy." } else { Write-Err2 "Restored but health check failed: $($h.detail)" }
    exit 0
}

# -- Build desired environment --
if (-not $EnvFile) {
    Write-Err2 "-EnvFile is required. Generate it first:"
    Write-Err2 "    node scripts\lti-keygen.mjs | Out-File `"`$env:USERPROFILE\lti-secrets.txt`" -Encoding ascii"
    exit 1
}

Write-Step "Reading secrets"
$fromFile = Read-EnvFile $EnvFile
$secrets = [ordered]@{}
$ignored = @()
foreach ($k in $fromFile.Keys) {
    if (Test-AllowedKey $k) { $secrets[$k] = $fromFile[$k] } else { $ignored += $k }
}
Write-Ok "$($secrets.Count) usable variable(s) from $EnvFile"
if ($ignored.Count -gt 0) {
    Write-Warn2 "ignored (not an LTI variable): $($ignored -join ', ')"
}

# These must end up set, but they do not have to be supplied again: an earlier
# run may already have put them on the service. Only complain if a value is
# absent from BOTH the file and the current environment.
$required = @('LTI_TOOL_PRIVATE_KEY', 'LTI_PROVISION_SECRET')
$absent = @($required | Where-Object {
    -not $secrets.Contains($_) -and -not $current.Contains($_)
})
if ($absent.Count -gt 0) {
    Write-Err2 "Not set anywhere: $($absent -join ', ')"
    Write-Err2 "Generate them with: node scripts\lti-keygen.mjs"
    exit 1
}

$desired = [ordered]@{}
foreach ($k in $current.Keys)  { $desired[$k] = $current[$k] }
foreach ($k in $Defaults.Keys) { $desired[$k] = $Defaults[$k] }
foreach ($k in $secrets.Keys)  { $desired[$k] = $secrets[$k] }

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
    } else { $kept++ }
}
Write-Host ""
Write-Ok "$added added, $changed changed, $kept unchanged (total $($desired.Count))"

if ($kept -eq 0) {
    Write-Warn2 "Nothing was carried over from the existing environment. That is only"
    Write-Warn2 "correct if the service genuinely had no variables before."
}

if (-not $Apply) {
    Write-Host ""
    Write-Warn2 "DRY RUN -- nothing has been written."
    Write-Warn2 "Rerun with -Apply to make these changes."
    exit 0
}

Write-Step "Writing environment"
try {
    Set-RegistryEnvironment $desired
} catch {
    Write-Err2 "Write failed: $($_.Exception.Message)"
    Write-Err2 "Restore: .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}

# Read back before restarting: a value that did not land is far cheaper to
# find now than after the service is down.
$verify = Get-RegistryEnvironment 'AppEnvironmentExtra'
$mismatch = @()
foreach ($k in $desired.Keys) {
    if (-not $verify.Contains($k) -or $verify[$k] -ne $desired[$k]) { $mismatch += $k }
}
if ($mismatch.Count -gt 0) {
    Write-Err2 "These did not land correctly: $($mismatch -join ', ')"
    Write-Err2 "Restore: .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}
Write-Ok "written and verified ($($verify.Count) variables)"

Write-Step "Restarting $ServiceName"
try {
    Restart-InfuseService
    Write-Ok "running"
} catch {
    Write-Err2 $_.Exception.Message
    Write-Err2 "Restore: .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
    exit 1
}

Write-Step "Health check"
$health = Test-Health
if ($health.ok) {
    Write-Ok "GET /lti/jwks returned a keyset:"
    Write-Host "      $($health.detail)" -ForegroundColor DarkGray
    Write-Host ""
    Write-Ok "Confirm the kid reads infuse-lti-1 -- that is what the host portal looks for."
} else {
    Write-Err2 "Health check failed: $($health.detail)"
    Write-Err2 ""
    Write-Err2 "Likely causes, in order:"
    Write-Err2 "  1. LTI_TOOL_PRIVATE_KEY lost its \n escapes -> /lti/jwks 500s"
    Write-Err2 "  2. The new code is not deployed -> /lti/jwks 404s"
    Write-Err2 "  3. The service did not come back cleanly -> check sc.exe query $ServiceName"
    Write-Err2 ""
    Write-Err2 "Roll back: .\scripts\lti-setup-origin.ps1 -Restore `"$backupPath`" -Apply"
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
