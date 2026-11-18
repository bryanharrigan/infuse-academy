<#
.SYNOPSIS
    Checks, stages, commits and pushes the cross-portal LTI tool.

.DESCRIPTION
    Runs on the CORPORATE LAPTOP (absorb-9r0cl44), in C:\Projects\infuse-academy.
    That machine edits and pushes; it does not serve the site. The origin box
    picks the push up within a minute via the deploy daemon.

    For the environment variables on the origin, use lti-setup-origin.ps1
    instead -- different machine, needs elevation.

    Safe by default: it shows you exactly what it will commit and asks before
    doing it. Nothing is pushed until the commit succeeds.

.PARAMETER SkipChecks
    Skip typecheck and tests. Only sensible if you have just run them.

.PARAMETER NoPush
    Commit locally but do not push.

.PARAMETER Yes
    Do not prompt for confirmation. For unattended reruns.

.EXAMPLE
    cd C:\Projects\infuse-academy
    .\scripts\lti-commit.ps1

.EXAMPLE
    .\scripts\lti-commit.ps1 -SkipChecks -Yes
#>

[CmdletBinding()]
param(
    [switch]$SkipChecks,
    [switch]$NoPush,
    [switch]$Yes
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step  ([string]$m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Write-Ok    ([string]$m) { Write-Host "    $m" -ForegroundColor Green }
function Write-Warn2 ([string]$m) { Write-Host "    $m" -ForegroundColor Yellow }
function Write-Err2  ([string]$m) { Write-Host "    $m" -ForegroundColor Red }

# Repo root is this script's parent, so the script works from any cwd.
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

# The files this change introduces. Explicit rather than `git add -A`: the repo
# is PUBLIC and .env.production has lived untracked in a sibling checkout, so a
# blanket add is exactly the mistake worth engineering out.
$Files = @(
    'app/.server/lti/ags.ts'
    'app/.server/lti/claims.ts'
    'app/.server/lti/deeplink-store.ts'
    'app/.server/lti/jwt.ts'
    'app/.server/lti/keys.ts'
    'app/.server/lti/platforms.ts'
    'app/.server/lti/portal.ts'
    'app/.server/lti/store.ts'
    'app/routes/api.lti.webhook.ts'
    'app/routes/lti.deeplink.tsx'
    'app/routes/lti.jwks.ts'
    'app/routes/lti.launch.ts'
    'app/routes/lti.login.ts'
    'app/routes/lti.play.tsx'
    'test/lti/lti.test.ts'
    'test/lti/run.mjs'
    'scripts/lti-keygen.mjs'
    'scripts/lti-commit.ps1'
    'scripts/lti-setup-origin.ps1'
    'LTI_SETUP.md'
    'env.lti.example'
)

# Anything matching these must never reach a public repo. Checked against what
# is actually staged, after staging, so it catches a stray match too.
$SecretPatterns = @(
    '\.env($|\.)'          # .env, .env.production, .env.local
    '\.pem$'
    '\.key$'
    '\.pfx$'
    'lti-env'              # the KEY=VALUE file lti-setup-origin.ps1 consumes
    'private.*key'
)

Write-Step "Repository"
if (-not (Test-Path (Join-Path $RepoRoot '.git'))) {
    Write-Err2 "No .git here. Expected to run inside C:\Projects\infuse-academy."
    Write-Err2 "Found: $RepoRoot"
    exit 1
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Err2 "git is not on PATH."
    exit 1
}
Write-Ok $RepoRoot

$branch = (& git rev-parse --abbrev-ref HEAD).Trim()
Write-Ok "branch: $branch"
if ($branch -ne 'main') {
    Write-Warn2 "Not on main. The deploy daemon only follows main, so this will not deploy."
    if (-not $Yes) {
        $go = Read-Host "    Continue anyway? (y/N)"
        if ($go -ne 'y') { Write-Host "Aborted."; exit 0 }
    }
}

Write-Step "Files to commit"
$missing = @()
foreach ($f in $Files) {
    if (Test-Path (Join-Path $RepoRoot $f)) {
        Write-Host ("    {0}" -f $f)
    } else {
        $missing += $f
    }
}
if ($missing.Count -gt 0) {
    Write-Err2 "Missing from the working tree:"
    $missing | ForEach-Object { Write-Err2 "      $_" }
    Write-Err2 "Nothing has been staged. Check the files landed before rerunning."
    exit 1
}

# This laptop is an edit-and-push machine: Node may not be installed on it at
# all, and node_modules may be absent even if it is. That is not a reason to
# refuse to commit -- the origin runs npm ci and the build on every deploy, so
# a type error surfaces there. Look for the toolchain, use it if present, say
# so plainly if not.
function Resolve-Tool ([string[]]$names, [string[]]$paths) {
    foreach ($n in $names) {
        $cmd = Get-Command $n -ErrorAction SilentlyContinue
        if ($cmd) { return $cmd.Source }
    }
    foreach ($p in $paths) {
        if ($p -and (Test-Path $p)) { return $p }
    }
    return $null
}

# Join-Path throws on a null root, and an unset variable here would abort the
# whole script, so filter first.
function Join-IfSet ([string]$root, [string]$rest) {
    if ([string]::IsNullOrWhiteSpace($root)) { return $null }
    return (Join-Path $root $rest)
}

$npmExe = Resolve-Tool @('npm.cmd', 'npm') @(
    (Join-IfSet $env:ProgramFiles 'nodejs\npm.cmd')
    (Join-IfSet ${env:ProgramFiles(x86)} 'nodejs\npm.cmd')
    (Join-IfSet $env:APPDATA 'npm\npm.cmd')
    (Join-IfSet $env:LOCALAPPDATA 'Programs\nodejs\npm.cmd')
)
$nodeExe = Resolve-Tool @('node.exe', 'node') @(
    (Join-IfSet $env:ProgramFiles 'nodejs\node.exe')
    (Join-IfSet $env:LOCALAPPDATA 'Programs\nodejs\node.exe')
    (Join-IfSet $env:APPDATA 'nvm\node.exe')
)
$haveModules = Test-Path (Join-Path $RepoRoot 'node_modules')

if ($SkipChecks) {
    Write-Warn2 "Skipping typecheck and tests (-SkipChecks)."
} else {
    Write-Step "Typecheck"
    if (-not $npmExe) {
        Write-Warn2 "npm not found on this machine -- skipping."
    } elseif (-not $haveModules) {
        Write-Warn2 "node_modules is absent -- skipping (tsc is not installed here)."
    } else {
        # npm.ps1 is blocked by execution policy on these machines; npm.cmd is
        # not. Do not 'fix' this with Set-ExecutionPolicy.
        & $npmExe run typecheck
        if ($LASTEXITCODE -ne 0) {
            Write-Err2 "tsc failed. Nothing staged."
            exit 1
        }
        Write-Ok "clean"
    }

    Write-Step "LTI tests"
    if (-not $nodeExe) {
        Write-Warn2 "node not found on this machine -- skipping."
    } elseif (-not $haveModules) {
        Write-Warn2 "node_modules is absent -- skipping (the tests need esbuild)."
    } else {
        & $nodeExe test/lti/run.mjs
        if ($LASTEXITCODE -ne 0) {
            Write-Err2 "Tests failed. Nothing staged."
            exit 1
        }
        Write-Ok "passed"
    }

    if (-not $npmExe -or -not $nodeExe -or -not $haveModules) {
        Write-Host ""
        Write-Warn2 "Checks could not run here. They are not lost: the origin runs"
        Write-Warn2 "npm ci and the build on every deploy, and the deploy daemon"
        Write-Warn2 "health-checks the result before leaving the new version live."
    }
}

Write-Step "Staging"
& git add -- $Files
if ($LASTEXITCODE -ne 0) { Write-Err2 "git add failed."; exit 1 }

$staged = @(& git diff --cached --name-only)
if ($staged.Count -eq 0) {
    Write-Ok "Nothing to commit -- the working tree already matches HEAD."
    exit 0
}

# Safety net: re-inspect what is actually staged, not what we meant to stage.
$danger = @()
foreach ($s in $staged) {
    foreach ($p in $SecretPatterns) {
        if ($s -match $p) { $danger += $s; break }
    }
}
if ($danger.Count -gt 0) {
    Write-Err2 "Refusing to commit -- these look like secrets and this repo is PUBLIC:"
    $danger | ForEach-Object { Write-Err2 "      $_" }
    & git reset HEAD -- $Files | Out-Null
    Write-Err2 "Staging has been undone. Nothing was committed."
    exit 1
}

Write-Host ""
& git diff --cached --stat

if (-not $Yes) {
    Write-Host ""
    $go = Read-Host "Commit these $($staged.Count) file(s)? (y/N)"
    if ($go -ne 'y') {
        & git reset HEAD -- $Files | Out-Null
        Write-Host "Aborted. Staging undone; your files are untouched."
        exit 0
    }
}

Write-Step "Commit"
$msg = @"
Add cross-portal LTI 1.3 tool

Lets an Absorb portal (host) play an Online Course that lives on a different
Absorb portal (source), with the host portal as the LTI Consumer and this app
as the Tool.

- OIDC login initiation, launch verification, deep linking and AGS passback
- Portal-scoped Absorb client: upsert learner on iss+sub, admin enrol, mint
  the player URL. Online Courses only.
- Completion webhook from the source portal drives the AGS score
- No new dependencies: RS256 and JWK handling use node:crypto
- 17 self-contained tests, no portal or LMS required

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01N5bF6FWfMfYiJ8381LHP8G
"@

& git commit -m $msg
if ($LASTEXITCODE -ne 0) { Write-Err2 "Commit failed."; exit 1 }
Write-Ok (& git log -1 --oneline)

if ($NoPush) {
    Write-Step "Push skipped (-NoPush)"
    Write-Warn2 "Run 'git push' when ready -- nothing deploys until you do."
    exit 0
}

Write-Step "Push"
& git push origin $branch
if ($LASTEXITCODE -ne 0) {
    Write-Err2 "Push failed. The commit is safe locally; fix and 'git push' again."
    exit 1
}
Write-Ok "pushed to origin/$branch"

$__msg = @"

Next, on the ORIGIN machine (DESKTOP-HGPP7U3), in an ELEVATED PowerShell:

    node scripts\lti-keygen.mjs        # generates the two secrets
    .\scripts\lti-setup-origin.ps1 -EnvFile <file with those two lines>

The deploy daemon polls once a minute, so the code will already be there.
If it does not appear, check it is still running:

    sc.exe qc infuse-deploy           # expect START_TYPE: AUTO_START
    sc.exe query infuse-deploy        # expect RUNNING

"@
Write-Host $__msg -ForegroundColor DarkGray
