# Headless runner for the x402 index.
#
# EVERY command redirects to logs\ and spawns NO window. That is a hard house
# rule: Michael's standing instruction is "don't show any windows." Calling
# python directly with PowerShell redirection inherits the current console and
# creates none. Do NOT "improve" this file by adding Start-Process — that is
# exactly the change that pops a console window on his desktop.
#
# Usage:
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 catalog
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 probe 40
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 report
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 mismatch   # regenerate the price-mismatch feed only
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 daily      # catalog + sample + report + mismatch feed
#   powershell -File C:\Users\Micha\Desktop\x402\run.ps1 full-sweep # ALL ~15.5k routes, hours
#
# Read a log later:
#   Get-Content C:\Users\Micha\Desktop\x402\logs\report-*.log -Encoding UTF8 -Tail 60

param(
    [Parameter(Position = 0)][string]$Task = "daily",
    [Parameter(Position = 1)][int]$Sample = 40
)

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Logs = Join-Path $Here "logs"
if (-not (Test-Path $Logs)) { New-Item -ItemType Directory -Path $Logs | Out-Null }
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Set-Location $Here

function Invoke-Step {
    param([string]$Name, [string[]]$PyArgs)
    $log = Join-Path $Logs "$Name-$Stamp.log"
    # Write-Host, NOT Write-Output. Write-Output goes into the pipeline and
    # would be captured by the caller's `$l = Invoke-Step ...`, so `$l` becomes
    # an array of [status string, path] and Get-Content then tries to open the
    # status line as a filename. This exact bug shipped once already.
    Write-Host "-> $Name  (log: $log)"
    # Native redirection: no cmd.exe, no extra process, no window.
    & python @PyArgs *> $log
    if ($LASTEXITCODE -ne 0) { Write-Host "   FAILED exit=$LASTEXITCODE - read $log" }
    return $log
}

switch ($Task) {
    "catalog" { Invoke-Step "catalog" @("fetch_catalog.py") | Out-Null }
    "probe"   { Invoke-Step "probe"   @("probe.py", "--sample", "$Sample") | Out-Null }
    "report" {
        $l = Invoke-Step "report" @("report.py")
        # -Encoding UTF8 matters: the scripts write UTF-8 and Get-Content
        # otherwise decodes as ANSI, turning every dash into mojibake.
        Get-Content $l -Encoding UTF8
    }
    "mismatch" {
        # Standing safety feed (severity-tiered CRITICAL/HIGH/LOW, ranked by dollar
        # exposure). Read-only against the DB; safe to run any time after a report,
        # or on its own to refresh the feed against the last probe run without
        # re-fetching/re-probing. The API's /mismatches endpoint reads mismatch.json
        # directly (see api/queries.py) -- run this whenever the feed looks stale.
        $l = Invoke-Step "mismatch" @("mismatch_report.py")
        Get-Content $l -Encoding UTF8
    }
    "daily" {
        Invoke-Step "catalog" @("fetch_catalog.py") | Out-Null
        Invoke-Step "probe"   @("probe.py", "--sample", "$Sample") | Out-Null
        $rl = Invoke-Step "report" @("report.py")
        Get-Content $rl -Encoding UTF8
        $ml = Invoke-Step "mismatch" @("mismatch_report.py")
        Get-Content $ml -Encoding UTF8
    }
    "full-sweep" {
        # THE WIDE RUN. ~15.5k routes across ~1,577 hosts, one request each,
        # serialised per host with a 2s gap. Expect HOURS, dominated by the few
        # hosts that list dozens of routes. Deliberately behind its own verb so
        # nobody triggers an ecosystem-wide sweep by fat-fingering an argument.
        Invoke-Step "catalog"    @("fetch_catalog.py") | Out-Null
        Invoke-Step "full-sweep" @("probe.py", "--all", "--host-concurrency", "8", "--delay", "2.0") | Out-Null
        $rl = Invoke-Step "report" @("report.py")
        Get-Content $rl -Encoding UTF8
        $ml = Invoke-Step "mismatch" @("mismatch_report.py")
        Get-Content $ml -Encoding UTF8
    }
    default { Write-Host "unknown task '$Task'. use: catalog | probe | report | mismatch | daily | full-sweep" }
}
