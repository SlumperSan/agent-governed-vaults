# The managed pid set for one soak run.
#
# The single place run-soak.ps1's -Stop and -Status, and every place it starts OR reuses a
# service, read and write the pid file. This exists to fix a measured defect: `Start-Service-Once`
# recorded a pid ONLY when it freshly started a process. When it found one already running (a
# previous invocation's indexer/canary/sampler, still alive because nobody had called -Stop) it
# reused it silently and never wrote it down -- and the very next line in run-soak.ps1 deletes and
# recreates the pid file for the new invocation. So `-Stop` had a record of whatever THIS
# invocation happened to freshly start (that one run, just `api`) and nothing at all for three
# services that were very much running and rewriting `data/indexer-state.json`. `-Stop` reported
# "api was not running" and left indexer, canary and sampler alive; `-Status` could not see them
# either, for the identical reason -- both only ever read this same file.
#
# The fix is structural, not a bigger try/catch: the started-set and the stopped-set must be
# derived from ONE place, so they cannot drift apart again. Every caller that starts OR reuses a
# service calls Add-ManagedPid; -Stop and -Status call nothing but Get-ManagedPidEntries and
# Test-ManagedProcessAlive. There is no second path that writes or reads this file.
#
# Entries are `name=pid=needle`. `needle` is the command-line substring that identified this
# process (the same string Test-AlreadyRunning in run-soak.ps1 matched on) -- recorded so a pid
# that still exists, but now belongs to a DIFFERENT process because Windows recycled the number,
# reads as "not the service we started" rather than as a false RUNNING/stopped-successfully. An
# empty needle skips that cross-check (used for the powershell.exe track wrappers, whose
# command line is a long joined argument string that is not worth needle-matching).

function Add-ManagedPid {
  param(
    [Parameter(Mandatory)][string]$PidFile,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)]$ProcessId,
    [string]$Needle = ''
  )
  # `=` cannot appear in $Name or $Needle by construction (script-chosen names; $Needle is a
  # script/module path) so a plain split on the first two `=` is unambiguous.
  Add-Content -Path $PidFile -Value "$Name=$ProcessId=$Needle"
}

function Get-ManagedPidEntries {
  param([Parameter(Mandatory)][string]$PidFile)
  if (-not (Test-Path $PidFile)) { return @() }
  $rows = @(Get-Content $PidFile | Where-Object { $_ -match '=' } | ForEach-Object {
    $parts = $_ -split '=', 3
    [pscustomobject]@{
      Name      = $parts[0]
      ProcessId = [int]$parts[1]
      Needle    = if ($parts.Count -gt 2) { $parts[2] } else { '' }
    }
  })
  return ,$rows
}

# True only when a process with this pid exists AND, if a needle was recorded, its command line
# still contains that needle. A bare `Get-Process -Id` cannot tell a live managed service apart
# from an unrelated process the OS later handed the same, now-recycled, pid.
function Test-ManagedProcessAlive {
  param([Parameter(Mandatory)]$ProcessId, [string]$Needle = '')
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return $false }
  if ([string]::IsNullOrEmpty($Needle)) { return $true }
  return [bool]($proc.CommandLine -and $proc.CommandLine -like "*$Needle*")
}

# Start a process, and only report/record it as "started" once it has SURVIVED a moment --
# recording a pid is not evidence a process survived. Measured: the api crashed at startup
# (`resolveApiConfig` threw on missing PRICE_ASSET/PRICE_PAYTO) and run-soak.ps1 printed
# "started api pid 23120" anyway, because the old Start-Bg recorded the pid and printed success
# the instant Start-Process returned -- which only proves the OS accepted the exec, not that the
# process is doing anything. A `node ... serve.mjs` that throws inside a synchronous config
# resolution at the top of `main()` exits within milliseconds, well inside any human's ability to
# notice from a stream of green "started" lines.
#
# Returns the process object on success, or $null on a confirmed-dead-on-arrival launch -- $null,
# not a thrown error, because the CALLER decides whether this particular service is load-bearing
# enough to abort the whole run over (see run-soak.ps1: the four core services do; the drill
# tracks do not, since New-NodeStep already aborts a track on its own first non-zero exit).
function Start-ManagedProcess {
  param(
    [Parameter(Mandatory)][string]$PidFile,
    [Parameter(Mandatory)][string]$Name,
    [Parameter(Mandatory)][string]$File,
    [string[]]$ArgList = @(),
    [string]$Needle = '',
    [Parameter(Mandatory)][string]$LogDir,
    [int]$SettleMs = 1200
  )
  $out = Join-Path $LogDir "$Name.log"
  $err = Join-Path $LogDir "$Name.err.log"
  $p = Start-Process -FilePath $File -ArgumentList $ArgList -NoNewWindow -PassThru `
       -RedirectStandardOutput $out -RedirectStandardError $err

  Start-Sleep -Milliseconds $SettleMs
  $p.Refresh()
  if ($p.HasExited) {
    Write-Host ("  {0,-16} FAILED - exited {1}ms after launch, exit code {2}" -f $Name, $SettleMs, $p.ExitCode) -ForegroundColor Red
    if (Test-Path $err) {
      Write-Host "  --- $Name.err.log (tail) ---" -ForegroundColor Red
      Get-Content $err -Tail 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    } else {
      Write-Host "  (no $Name.err.log was written)" -ForegroundColor Red
    }
    return $null
  }

  Add-ManagedPid -PidFile $PidFile -Name $Name -ProcessId $p.Id -Needle $Needle
  Write-Host ("  started {0,-16} pid {1}" -f $Name, $p.Id) -ForegroundColor Green
  return $p
}

Export-ModuleMember -Function Add-ManagedPid, Get-ManagedPidEntries, Test-ManagedProcessAlive, Start-ManagedProcess
