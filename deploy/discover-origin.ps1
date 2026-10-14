<#
  discover-origin.ps1
  READ-ONLY probe of the Infuse Academy origin machine (the Windows PC running
  cloudflared + Node on :3000).

  This script CHANGES NOTHING. It starts no services, writes no files outside
  its own stdout, and installs nothing.

  It deliberately does NOT print secrets. Files that hold credentials (.env,
  .infuse-admin-token.json, the tunnel credentials JSON) are reported as
  present/absent with size and date only — never their contents.

  Run from an elevated PowerShell on the ORIGIN machine:

      powershell -ExecutionPolicy Bypass -File .\discover-origin.ps1

  Then paste the output back into the Claude session.
#>

$ErrorActionPreference = 'SilentlyContinue'

function Section($name) {
    Write-Output ""
    Write-Output "===== $name ====="
}

Write-Output "Infuse Academy — origin machine discovery"
Write-Output "Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')"

# ---------------------------------------------------------------- machine ---
Section "Machine"
Write-Output "Hostname      : $env:COMPUTERNAME"
Write-Output "User          : $env:USERDOMAIN\$env:USERNAME"
Write-Output "Elevated      : $( ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent() `
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) )"
$os = Get-CimInstance Win32_OperatingSystem
Write-Output "OS            : $($os.Caption) $($os.Version)"
Write-Output "Last boot     : $($os.LastBootUpTime)"

# ---------------------------------------------------------------- toolchain -
Section "Toolchain"
foreach ($tool in 'node', 'npm', 'git', 'nssm', 'pm2', 'cloudflared') {
    $cmd = Get-Command $tool -ErrorAction SilentlyContinue
    if ($cmd) {
        $ver = & $tool --version 2>&1 | Select-Object -First 1
        Write-Output ("{0,-12} {1,-10} {2}" -f $tool, $ver, $cmd.Source)
    } else {
        Write-Output ("{0,-12} NOT FOUND" -f $tool)
    }
}

# ------------------------------------------------------------ what owns 3000
Section "Listener on :3000"
$conns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
    Write-Output "Nothing is listening on :3000 right now."
} else {
    foreach ($c in $conns) {
        Write-Output "LocalAddress : $($c.LocalAddress):$($c.LocalPort)"
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
        if ($p) {
            Write-Output "  PID        : $($p.ProcessId)"
            Write-Output "  Name       : $($p.Name)"
            Write-Output "  Path       : $($p.ExecutablePath)"
            Write-Output "  CommandLine: $($p.CommandLine)"
            Write-Output "  ParentPID  : $($p.ParentProcessId)"
            $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($p.ParentProcessId)"
            if ($parent) {
                Write-Output "  Parent     : $($parent.Name)  $($parent.ExecutablePath)"
            }
            # Working directory is the strongest hint at the checkout location.
            Write-Output "  CWD hint   : $((Get-Process -Id $p.ProcessId).Path | Split-Path -Parent)"
        }
    }
}
Write-Output ""
Write-Output "-- Is :3000 bound to loopback only, or to all interfaces? --"
Write-Output "   (0.0.0.0 or :: means the app is reachable from the LAN, not just the tunnel)"
$conns | Select-Object LocalAddress, LocalPort, State | Format-Table -AutoSize | Out-String

# --------------------------------------------------------- how it stays up --
Section "Supervision — services"
Get-CimInstance Win32_Service |
    Where-Object { $_.Name -match 'infuse|nssm|pm2|cloudflared' -or $_.PathName -match 'node|infuse' } |
    Select-Object Name, State, StartMode, StartName, PathName |
    Format-Table -AutoSize -Wrap | Out-String

Section "Supervision — scheduled tasks"
Get-ScheduledTask |
    Where-Object {
        $_.Actions.Execute -match 'node|npm|cmd|powershell|infuse' -and
        $_.TaskPath -notmatch '^\\Microsoft\\'
    } |
    ForEach-Object {
        $info = $_ | Get-ScheduledTaskInfo
        [pscustomobject]@{
            Task      = "$($_.TaskPath)$($_.TaskName)"
            State     = $_.State
            Triggers  = ($_.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ','
            RunAs     = $_.Principal.UserId
            Execute   = $_.Actions.Execute
            Arguments = $_.Actions.Arguments
            LastRun   = $info.LastRunTime
        }
    } | Format-List | Out-String

Section "Supervision — startup folder / run keys"
foreach ($k in @(
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Run',
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
)) {
    $props = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue
    if ($props) {
        $props.PSObject.Properties |
            Where-Object { $_.Name -notmatch '^PS' } |
            ForEach-Object { Write-Output "$k  $($_.Name) = $($_.Value)" }
    }
}
Get-ChildItem "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup" -ErrorAction SilentlyContinue |
    Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize | Out-String

# ------------------------------------------------------------- cloudflared --
Section "Cloudflare Tunnel"
$cfPaths = @(
    "C:\Windows\System32\config\systemprofile\.cloudflared",
    "$env:USERPROFILE\.cloudflared",
    "C:\ProgramData\cloudflared",
    "C:\etc\cloudflared"
)
foreach ($dir in $cfPaths) {
    if (Test-Path $dir) {
        Write-Output "Directory: $dir"
        Get-ChildItem $dir -File | ForEach-Object {
            # *.json in here is tunnel credentials — list it, never read it.
            $flag = if ($_.Extension -eq '.json') { '  [CREDENTIALS — not printed]' } else { '' }
            Write-Output ("  {0,-28} {1,8} bytes  {2}{3}" -f $_.Name, $_.Length, $_.LastWriteTime, $flag)
        }
        foreach ($cfg in @('config.yml', 'config.yaml')) {
            $p = Join-Path $dir $cfg
            if (Test-Path $p) {
                Write-Output ""
                Write-Output "  --- $p ---"
                Get-Content $p | ForEach-Object { Write-Output "  $_" }
            }
        }
        Write-Output ""
    }
}

# ---------------------------------------------------------------- checkout --
Section "Repo checkout"
# Prefer the CWD of whatever is serving :3000, then fall back to common paths.
$candidates = @()
if ($conns) {
    foreach ($c in $conns) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $($c.OwningProcess)"
        if ($p.CommandLine -match '([A-Za-z]:\\[^"]*?infuse[^"\\]*)') {
            $candidates += $Matches[1]
        }
    }
}
$candidates += @(
    'C:\Infuse',
    'C:\Infuse\infuse-academy',
    'C:\Projects\infuse-academy',
    'C:\infuse-academy',
    'C:\apps\infuse-academy',
    "$env:USERPROFILE\infuse-academy",
    "$env:USERPROFILE\Projects\infuse-academy",
    'C:\inetpub\infuse-academy'
)

$found = @()
foreach ($dir in ($candidates | Select-Object -Unique)) {
    if ((Test-Path (Join-Path $dir 'package.json')) -and (Test-Path (Join-Path $dir '.git'))) {
        $found += $dir
    }
}

if (-not $found) {
    Write-Output "No checkout found at the usual paths. Searching C:\ two levels deep..."
    $found = Get-ChildItem 'C:\' -Directory -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { Test-Path (Join-Path $_.FullName 'package.json') } |
        Where-Object { Test-Path (Join-Path $_.FullName '.git') } |
        Select-Object -ExpandProperty FullName
}

foreach ($dir in $found) {
    Write-Output ""
    Write-Output "--- $dir ---"
    Push-Location $dir
    Write-Output "package name  : $( (Get-Content package.json -Raw | ConvertFrom-Json).name )"
    Write-Output "remote        : $(git remote get-url origin 2>&1)"
    Write-Output "branch        : $(git rev-parse --abbrev-ref HEAD 2>&1)"
    Write-Output "HEAD          : $(git rev-parse HEAD 2>&1)"
    Write-Output "HEAD date     : $(git log -1 --format=%ci 2>&1)"
    Write-Output "HEAD subject  : $(git log -1 --format=%s 2>&1)"
    Write-Output "dirty files   :"
    git status --porcelain 2>&1 | Select-Object -First 25 | ForEach-Object { Write-Output "  $_" }
    Write-Output "signed commits: $(git log -1 --format='%G? %GS' 2>&1)   (G=good, N=none)"

    foreach ($f in @('.env', '.env.local', '.env.production', '.infuse-admin-token.json')) {
        if (Test-Path $f) {
            $fi = Get-Item $f
            $keys = (Get-Content $f | Where-Object { $_ -match '^\s*[A-Z_][A-Z0-9_]*\s*=' } |
                     ForEach-Object { ($_ -split '=')[0].Trim() }) -join ', '
            Write-Output "$f : PRESENT, $($fi.Length) bytes, $($fi.LastWriteTime)"
            Write-Output "  keys only (NO VALUES): $keys"
        } else {
            Write-Output "$f : absent"
        }
    }

    foreach ($d in @('node_modules', 'build', 'build\client', 'build\server')) {
        if (Test-Path $d) {
            $i = Get-Item $d
            Write-Output "$d : present, modified $($i.LastWriteTime)"
        } else {
            Write-Output "$d : ABSENT"
        }
    }
    Pop-Location
}

# ------------------------------------------------------------ health probe --
Section "Local health probe"
foreach ($path in @('/healthz', '/')) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:3000$path" -UseBasicParsing `
             -TimeoutSec 5 -MaximumRedirection 0 -ErrorAction Stop
        Write-Output "GET $path -> $($r.StatusCode) $($r.StatusDescription)  ($($r.RawContentLength) bytes)"
    } catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code) { Write-Output "GET $path -> $code" }
        else { Write-Output "GET $path -> FAILED: $($_.Exception.Message)" }
    }
}

Section "Done"
Write-Output "Nothing was modified. Paste this whole report back into the Claude session."
Write-Output "Double-check before pasting: no secret VALUES should appear above, only key names."
