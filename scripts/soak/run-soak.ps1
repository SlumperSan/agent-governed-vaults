# Sprint-12 soak: unattended launcher.
#
# Starts the read-only services, the oracle sampler, and BOTH drill tracks in parallel.
# Governance serializes per VAULT, not per process, so track A (vault B) and track B (smoke
# vault) genuinely overlap - running them serially wastes about six hours.
#
#   Track A: drill1-multivault  ->  drill3-modef
#   Track B: drill2-subvault    ->  drill5(join) -> drill5(activate)
#                               ->  drill5-gov-companion (background)
#                               ->  drill5(vote + exit) -> wait for the companion
#
# Everything logs to .\logs\*.log. Every drill is resumable, so a crash or a reboot costs only
# the step in flight. Nothing needs a human once the password files are in place.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1
#         powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1 -SkipAgent
#         powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1 -Status
#         powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1 -Stop
#
# Env READ if you set it:  SOAK_RPC         (default https://sepolia.base.org; BASE_SEPOLIA_RPC is
#                                            read as a fallback so an existing environment still
#                                            works. Set it together with SOAK_DEPLOYMENT when the
#                                            run targets a chain other than Base Sepolia - every
#                                            drill refuses a pair that disagrees, in
#                                            deployment.mjs assertLiveChainId)
#                          SOAK_DEPLOYMENT  (default contracts\config\deployments\base-sepolia.json,
#                                            the address book that decides which chain is expected)
#                          SOAK_API         (default http://127.0.0.1:8402)
#                          SOAK_STATE_DIR   (default <repo>\scripts\soak - where the drills keep
#                                            their resumable state; this script only reads it to
#                                            find the companion's file)
#                          SOAK_AGENT_CAP_USDC (default 5.00 - drill 5's x402 session spend cap,
#                                            per phase poll window, see drill5-agent-execute.mjs)
# Env SET by this script (your value is overwritten): SOAK_SIGNER_ARGS, SOAK_PROBE_MEMBER,
#                          SOAK_PHASE, AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS, SOAK_AGENT_KEYSTORE,
#                          SOAK_AGENT_KEYSTORE_PASSWORD
#                          START_BLOCK - defaulted from startBlock/deployBlock in the SOAK_DEPLOYMENT
#                          address book, ONLY if not already set in your environment. The script
#                          refuses to start (throws before launching anything) if that record has no
#                          usable block, rather than letting the indexer default it to 0.
#
# Also refuses to start if the smoke vault already carries an unfinalized proposal from an earlier
# aborted run (scripts/soak/preflight-governance.mjs) -- prints the diagnosis and, where one exists,
# the exact `cast send ... finalize(uint256) ...` (or markExpired) remedy. Never sends it for you.

param(
  [string]$SignerPasswordFile = "$env:USERPROFILE\.soak.pw",
  [string]$AgentPasswordFile  = "$env:USERPROFILE\.soak-agent.pw",
  [switch]$SkipAgent,   # skip drill 5 (e.g. the throwaway keystore has no password file yet)
  [switch]$Status,      # print what is running and the tail of each log, then exit
  [switch]$Stop         # stop everything this script started, then exit
)

$ErrorActionPreference = 'Stop'
$Root    = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# SOAK_LOG_DIR overrides where the pid file and logs live -- undocumented for normal use (the
# default is right), but it is what lets a test point a real invocation of THIS script at a throwaway
# directory instead of the worktree's own logs/, so -Status/-Stop can be exercised for real without
# colliding with (or leaving behind) state from an actual run.
$LogDir  = if ($env:SOAK_LOG_DIR) { $env:SOAK_LOG_DIR } else { Join-Path $Root 'logs' }
$PidFile = Join-Path $LogDir 'soak-pids.txt'

Import-Module -Force (Join-Path $PSScriptRoot 'soak-pidset.psm1')

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
Set-Location $Root

# ── -Status / -Stop ──────────────────────────────────────────────────────────
# Both read ONLY Get-ManagedPidEntries / Test-ManagedProcessAlive (soak-pidset.psm1) -- the same
# functions every start-or-reuse path below writes through, so what -Stop kills and what -Status
# reports can never diverge from what this script actually considers "ours".

if ($Status) {
  Write-Host "`n=== running processes ===" -ForegroundColor Cyan
  $entries = Get-ManagedPidEntries $PidFile
  if ($entries.Count -eq 0) {
    Write-Host '  (no pid file - nothing was started)'
  } else {
    foreach ($e in $entries) {
      $alive = Test-ManagedProcessAlive -ProcessId $e.ProcessId -Needle $e.Needle
      $tag = if ($alive) { 'RUNNING' } else { 'exited ' }
      Write-Host ("  [{0}] {1} (pid {2})" -f $tag, $e.Name, $e.ProcessId)
    }
  }
  Write-Host "`n=== log tails ===" -ForegroundColor Cyan
  Get-ChildItem $LogDir -Filter *.log -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "`n--- $($_.Name) ---" -ForegroundColor Yellow
    Get-Content $_.FullName -Tail 6
  }
  exit 0
}

if ($Stop) {
  $entries = Get-ManagedPidEntries $PidFile
  if ($entries.Count -eq 0) {
    Write-Host 'nothing to stop'
  } else {
    foreach ($e in $entries) {
      if (Test-ManagedProcessAlive -ProcessId $e.ProcessId -Needle $e.Needle) {
        try { Stop-Process -Id $e.ProcessId -Force -ErrorAction Stop; Write-Host "stopped $($e.Name) (pid $($e.ProcessId))" }
        catch { Write-Host "$($e.Name) (pid $($e.ProcessId)) was not running" }
      } else {
        Write-Host "$($e.Name) (pid $($e.ProcessId)) was not running"
      }
    }
    Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  }
  exit 0
}

# ── preflight ────────────────────────────────────────────────────────────────

Write-Host "`n=== Sprint-12 soak launcher ===" -ForegroundColor Cyan
Write-Host "root: $Root"

if (-not (Test-Path $SignerPasswordFile)) {
  throw "signer password file not found: $SignerPasswordFile`nCreate it with:`n  `"your-deployer-password`" | Out-File -NoNewline -Encoding ascii `"$SignerPasswordFile`""
}

# The address book, resolved exactly as deployment.mjs deploymentPath does, so the launcher and the
# drills cannot disagree about which chain this run targets. Resolved HERE and not beside $PidFile:
# $ErrorActionPreference is 'Stop', so a typo'd SOAK_DEPLOYMENT read above the -Status/-Stop blocks
# would throw before -Stop could kill the pids - and -Stop is what reaches the detached companion
# holding a --password-file.
$Book = if ($env:SOAK_DEPLOYMENT) {
          if ([System.IO.Path]::IsPathRooted($env:SOAK_DEPLOYMENT)) { $env:SOAK_DEPLOYMENT }
          else { Join-Path $Root $env:SOAK_DEPLOYMENT }
        } else { Join-Path $Root 'contracts\config\deployments\base-sepolia.json' }
if (-not (Test-Path $Book)) { throw "deployment record not found: $Book - set SOAK_DEPLOYMENT or fix the default path" }
$BookJson = Get-Content -Raw $Book | ConvertFrom-Json
# Read the signer from that book rather than repeating it here. The preflight below unlocks a
# keystore and compares the derived address against this value, so a second copy that drifted would
# reject the correct key or accept the wrong one.
$Deployer = $BookJson.deployer

# START_BLOCK for the indexer this script starts, from the SAME address book as $Deployer above -
# not from .env, and never defaulted to 0. This is the fix for the 2026-09 soak failure: .env.example
# ships START_BLOCK=0 as a placeholder, an operator's .env can carry that unedited or omit the line
# entirely, and index-runner.mjs's own default is 0 - so a normal `cp .env.example .env` produces an
# indexer that silently starts at the genesis block instead of the deployment's. Measured that day:
# lastBlock stuck near 2.8M against a chain head of 47.13M, ~2 hours to catch up against this
# script's own 5-minute deadline below.
#
# Setting $env:START_BLOCK here (before Start-Service-Once launches the indexer with
# --env-file=.env) wins over a stale or absent line in .env: Node's --env-file does NOT override a
# variable already present in the process environment (verified against the Node version in this
# worktree: `START_BLOCK=123 node --env-file=<file with START_BLOCK=0> -e "console.log(...)"` prints
# 123). An operator's own explicit override - set before invoking this script - is still respected.
$bookStartBlock = $BookJson.startBlock
if (-not $bookStartBlock) { $bookStartBlock = $BookJson.deployBlock }
if (-not $bookStartBlock -or [int]$bookStartBlock -le 0) {
  throw "deployment record $Book has no usable startBlock or deployBlock - refusing to start the indexer, which would otherwise default START_BLOCK to 0 and index the entire chain from genesis. Fix the address book before running the soak."
}
if (-not $env:START_BLOCK) { $env:START_BLOCK = "$bookStartBlock" }
Write-Host "  START_BLOCK = $env:START_BLOCK (from $Book)" -ForegroundColor Green

$env:SOAK_SIGNER_ARGS = "--account deployer --password-file $SignerPasswordFile"

# Prove the signer args work BEFORE launching anything long. This derives an address and
# spends nothing; getting it wrong here costs two seconds instead of two hours.
Write-Host "`nverifying signer args..." -ForegroundColor Cyan
$addr = (cast wallet address --account deployer --password-file $SignerPasswordFile 2>&1 | Select-Object -Last 1)
if ($LASTEXITCODE -ne 0 -or "$addr".Trim() -ne $Deployer) {
  Write-Host "  --account + --password-file did not work ($addr). Trying the --keystore form..." -ForegroundColor Yellow
  $ks = "$env:USERPROFILE\.foundry\keystores\deployer"
  $addr = (cast wallet address --keystore $ks --password-file $SignerPasswordFile 2>&1 | Select-Object -Last 1)
  if ($LASTEXITCODE -ne 0 -or "$addr".Trim() -ne $Deployer) {
    throw "cannot unlock the deployer keystore with $SignerPasswordFile (got: $addr). Check the password file has NO trailing newline."
  }
  $env:SOAK_SIGNER_ARGS = "--keystore $ks --password-file $SignerPasswordFile"
}
Write-Host "  OK - signer resolves to $Deployer" -ForegroundColor Green
Write-Host "  SOAK_SIGNER_ARGS = $env:SOAK_SIGNER_ARGS"

# Governance preflight: refuse loudly, before starting anything, if the smoke vault already
# carries a proposal from an earlier aborted run that governance's per-vault serialization would
# block every drill on. Measured 2026-09: track B failed at drill 2 twelve days after a run
# proposed-then-abandoned, with a message that named the symptom ("proposal 11 in status Active")
# deep inside drill 2's own preflight rather than the fix, before any drill had even started this
# time. scripts/soak/preflight-governance.mjs reads the SAME governance state and, when it refuses,
# prints the exact remedy command using the SOAK_SIGNER_ARGS just proven above -- but it never
# sends anything itself: finalizing on the operator's behalf, even to clear the script's own mess,
# is a broadcast this launcher must not make silently.
Write-Host "`nchecking governance state on the smoke vault..." -ForegroundColor Cyan
& node (Join-Path $PSScriptRoot 'preflight-governance.mjs')
if ($LASTEXITCODE -ne 0) {
  throw 'governance preflight refused to proceed (see the diagnosis and remedy printed above) -- settle it, then re-run'
}

$runAgent = -not $SkipAgent
if ($runAgent -and -not (Test-Path $AgentPasswordFile)) {
  Write-Host "`n  agent password file not found ($AgentPasswordFile) - SKIPPING drill 5." -ForegroundColor Yellow
  Write-Host "  Create it and re-run with -SkipAgent:`$false to include the agent drill:" -ForegroundColor Yellow
  Write-Host "    `"your-soak-throwaway-password`" | Out-File -NoNewline -Encoding ascii `"$AgentPasswordFile`"" -ForegroundColor Yellow
  $runAgent = $false
}

# Resolve the endpoint once, in the order lib.mjs and agent-policy.mjs resolve it, and export it
# under BOTH names: SOAK_RPC is what every soak script reads first, and BASE_SEPOLIA_RPC is left set
# so a tool that only knows the old name still sees the same endpoint.
$env:SOAK_RPC = if ($env:SOAK_RPC) { $env:SOAK_RPC }
                elseif ($env:BASE_SEPOLIA_RPC) { $env:BASE_SEPOLIA_RPC }
                else { 'https://sepolia.base.org' }
$env:BASE_SEPOLIA_RPC = $env:SOAK_RPC
$env:SOAK_API         = if ($env:SOAK_API) { $env:SOAK_API } else { 'http://127.0.0.1:8402' }
# Drill 4's freeze-safety probe needs a member who actually HAS a pending deposit. The deployer
# gets one during drill 1's and drill 2's 4h observation windows - that is the only window in
# which cancelPending has anything to cancel.
#
# The probe needs a VAULT LIST as well as a member, and this script deliberately does not set one.
# Only half the wiring was here for the whole of the 2026-09-03 run: SOAK_PROBE_MEMBER was set and
# SOAK_VAULTS was not, so oracle-sampler.mjs mapped over an empty list, emitted no freeze-safety
# rows at all, and the leg was silently absent for six hours. Setting SOAK_VAULTS here would not
# have fixed it either - drills 1 and 2 CREATE their vaults at runtime, so the addresses do not
# exist when the sampler starts. The sampler now DISCOVERS them from the indexer projection (the
# same source the canary uses) and records an explicit `not-configured` sentinel when it finds
# none, so the absence can never be silent again. Set SOAK_VAULTS only to override that.
$env:SOAK_PROBE_MEMBER = $Deployer

# ── launch ───────────────────────────────────────────────────────────────────

if (Test-Path $PidFile) { Remove-Item $PidFile -Force }

# NOTE: the argument parameter must NOT be called $Args. PowerShell is case-insensitive and
# $args is an automatic variable, so a parameter of that name is silently shadowed by the
# (empty) built-in and Start-Process receives null.
function Start-Bg([string]$Name, [string]$File, [string[]]$ArgList, [string]$Needle = '') {
  $out = Join-Path $LogDir "$Name.log"
  $err = Join-Path $LogDir "$Name.err.log"
  $p = Start-Process -FilePath $File -ArgumentList $ArgList -NoNewWindow -PassThru `
       -RedirectStandardOutput $out -RedirectStandardError $err
  Add-ManagedPid -PidFile $PidFile -Name $Name -ProcessId $p.Id -Needle $Needle
  Write-Host ("  started {0,-16} pid {1}" -f $Name, $p.Id) -ForegroundColor Green
  return $p
}

# One track step: run a node script, and abandon the track if it fails.
#
# $Phase sets SOAK_PHASE for that step only. drill5-agent-execute.mjs runs a single phase when
# SOAK_PHASE is set and every phase when it is empty or absent, so '' is the correct "all phases"
# encoding under either PowerShell semantics for clearing an environment variable.
function New-NodeStep([string]$Script, [string]$Phase = '') {
  $label = if ($Phase) { "$Script [$Phase]" } else { $Script }
  return "`$env:SOAK_PHASE = '$Phase'; Write-Host '>>> $label'; node '$Script'; " +
         "if (`$LASTEXITCODE -ne 0) { Write-Host 'FAILED: $label'; exit `$LASTEXITCODE }"
}

# Track steps: run one track's steps in sequence inside a single child powershell, so drill 3
# starts the moment drill 1 finishes without anyone watching for it. Each element must be a
# single-line statement - they are joined with '; '.
function Start-Track([string]$Name, [string[]]$Steps) {
  return Start-Bg $Name 'powershell.exe' @('-NoProfile','-ExecutionPolicy','Bypass','-Command', ($Steps -join '; '))
}

# Services read their configuration from .env (RPC_URL, the contract addresses, START_BLOCK,
# STATE_PATH, ...). Starting them WITHOUT --env-file silently produces a differently-configured
# indexer pointing at defaults, which is worse than not starting one at all.
$EnvArg = @()
if (Test-Path (Join-Path $Root '.env')) { $EnvArg = @('--env-file=.env') }
else { Write-Host "`n  WARNING: no .env found - services will run on defaults" -ForegroundColor Yellow }

# A second copy of a service is not harmless: two indexers write the same STATE_PATH, and two
# samplers interleave lines into the same series. Detect what is already running and leave it.
function Test-AlreadyRunning([string]$Needle) {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
             Where-Object { $_.CommandLine -and $_.CommandLine -like "*$Needle*" })
  return ,$procs
}

function Start-Service-Once([string]$Name, [string]$Script) {
  $existing = Test-AlreadyRunning $Script
  if ($existing.Count -gt 0) {
    $ids = ($existing | ForEach-Object { $_.ProcessId }) -join ', '
    if ($existing.Count -gt 1) {
      Write-Host ("  {0,-8} ALREADY RUNNING x{1} (pids {2}) - DUPLICATES, consider stopping all but one" -f $Name, $existing.Count, $ids) -ForegroundColor Red
    } else {
      Write-Host ("  {0,-8} already running (pid {1}) - reusing it" -f $Name, $ids) -ForegroundColor Yellow
    }
    # Record every REUSED pid too, not only freshly-started ones. -Stop and -Status only ever see
    # $PidFile (via soak-pidset.psm1); a service this invocation is relying on -- because it
    # skipped starting a duplicate -- but never wrote down cannot be stopped or shown by either.
    # This is the actual shape of the measured defect: indexer/canary/sampler were "already
    # running" from an earlier invocation and this branch ran for them, silently, while only the
    # freshly-started service (that one run: api) ended up in the new $PidFile.
    foreach ($p in $existing) { Add-ManagedPid -PidFile $PidFile -Name $Name -ProcessId $p.ProcessId -Needle $Script }
    return
  }
  Start-Bg $Name 'node' ($EnvArg + @($Script)) -Needle $Script | Out-Null
}

Write-Host "`nstarting read-only services..." -ForegroundColor Cyan
Start-Service-Once 'indexer' 'packages/indexer/src/index-runner.mjs'
Start-Service-Once 'api'     'apps/api/src/serve.mjs'
Start-Service-Once 'canary'  'packages/canary/src/canary-runner.mjs'
Start-Service-Once 'sampler' 'scripts/soak/oracle-sampler.mjs'

# The indexer must be running and CAUGHT UP before createVault is signed, or drill 1's
# dynamic-discovery claim is indistinguishable from a cold backfill. Rather than sleeping a
# fixed 30s and hoping, read its own state file and wait until it is within a few blocks of
# the chain head.
Write-Host "`nwaiting for the indexer to catch up to the chain head..." -ForegroundColor Cyan
$statePath = Join-Path $Root 'data\indexer-state.json'
$deadline = (Get-Date).AddMinutes(5)
while ($true) {
  Start-Sleep -Seconds 10
  if (-not (Test-Path $statePath)) { Write-Host '  (no indexer state yet)'; continue }
  try {
    $last = (Get-Content $statePath -Raw | ConvertFrom-Json).lastBlock
    $head = [int](cast block-number --rpc-url $env:SOAK_RPC)
    $lag = $head - $last
    Write-Host ("  indexer at {0}, head {1} (lag {2} blocks)" -f $last, $head, $lag)
    if ($lag -le 20) { Write-Host '  caught up.' -ForegroundColor Green; break }
  } catch { Write-Host "  (could not read progress: $($_.Exception.Message))" }
  if ((Get-Date) -gt $deadline) {
    throw 'indexer did not catch up within 5 minutes - do NOT start the drills; drill 1 cannot prove dynamic discovery against a lagging indexer'
  }
}

Write-Host "`nstarting drill tracks (these run in PARALLEL - governance serializes per vault)..." -ForegroundColor Cyan
Start-Track 'trackA' @(
  (New-NodeStep 'scripts/soak/drill1-multivault.mjs'),
  (New-NodeStep 'scripts/soak/drill3-modef.mjs')
) | Out-Null

$trackB = @(New-NodeStep 'scripts/soak/drill2-subvault.mjs')
if ($runAgent) {
  $env:AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS = 'yes'
  $env:SOAK_AGENT_KEYSTORE = "$env:USERPROFILE\.foundry\keystores\soak-throwaway"
  $env:SOAK_AGENT_KEYSTORE_PASSWORD = (Get-Content $AgentPasswordFile -Raw)
  # The x402 session spend cap the agent runs under, stated rather than left to a default a
  # reader would have to go find. drill5-agent-execute.mjs carries the same 5.00 as its own
  # default; scripts/test/soak-drills.test.mjs pins the two together.
  if (-not $env:SOAK_AGENT_CAP_USDC) { $env:SOAK_AGENT_CAP_USDC = '5.00' }
  Write-Host "  SOAK_AGENT_CAP_USDC = `$$($env:SOAK_AGENT_CAP_USDC) per phase poll window" -ForegroundColor Green

  # DRILL 5 AND THE GOVERNANCE COMPANION ARE EACH OTHER'S PRECONDITION, so drill 5 is split.
  #
  # drill5-gov-companion.mjs refuses to propose until the agent holds shares (it snapshots voting
  # weight at createdAt-1, so a round raised earlier would give the agent zero weight), and drill
  # 5's vote phase refuses to tick until a votable round exists. The only ordering that satisfies
  # both is: join, activate, THEN the companion, THEN vote. Each `node` invocation re-reads the
  # state file and skips what is already recorded done, so the split costs two extra preflights
  # and nothing else.
  $compOut   = Join-Path $LogDir 'gov-companion.log'
  $compErr   = Join-Path $LogDir 'gov-companion.err.log'
  # Mirrors drill5-gov-companion.mjs: SOAK_STATE_DIR ?? <repo>/scripts/soak, then the state file.
  $compStateDir = if ($env:SOAK_STATE_DIR) { $env:SOAK_STATE_DIR } else { Join-Path $Root 'scripts\soak' }
  $compState = Join-Path $compStateDir '.state-drill5gov.json'

  $trackB += New-NodeStep 'scripts/soak/drill5-agent-execute.mjs' 'join'
  $trackB += New-NodeStep 'scripts/soak/drill5-agent-execute.mjs' 'activate'

  # Background, because the companion outlives drill 5: it settles the agent's queued exit after
  # drill 5's exit phase. Start-Process detaches it, so stopping track B's powershell does NOT
  # reach it - its pid line in $PidFile is the only thing that does, and -Stop is what reads that
  # file. That is what keeps it from outliving the run, and why the operator must -Stop before
  # deleting the password files the companion signs with.
  $trackB += "Write-Host '>>> starting drill5-gov-companion (background) - drill 5 needs a votable round'"
  $trackB += "`$comp = Start-Process -FilePath 'node' -ArgumentList 'scripts/soak/drill5-gov-companion.mjs' " +
             "-WorkingDirectory '$Root' -NoNewWindow -PassThru -RedirectStandardOutput '$compOut' -RedirectStandardError '$compErr'"
  $trackB += "Add-Content -Path '$PidFile' -Value ('gov-companion=' + `$comp.Id)"
  $trackB += "Write-Host ('  started gov-companion pid ' + `$comp.Id)"

  # Then WAIT for the round to exist before drill 5 looks for it, or the vote gate loses a race it
  # would report as a governance problem. The signal is the companion's own state file: it writes
  # steps.propose.done after the proposal id is confirmed on chain. A half-written file throws in
  # ConvertFrom-Json and is simply retried on the next pass.
  #
  # Every exit from this loop is logged and NONE of them abort the track: if the companion could
  # not raise a round, drill 5's own round-availability diagnostic is the one that belongs on the
  # record, and masking it here with a launcher error would be the substitution this soak keeps
  # making.
  $trackB += "`$compDeadline = (Get-Date).AddMinutes(10)"
  $trackB += "while (`$true) { " +
             "`$raised = `$false; " +
             "if (Test-Path '$compState') { try { `$raised = [bool](Get-Content '$compState' -Raw | ConvertFrom-Json).steps.propose.done } catch { `$raised = `$false } }; " +
             "if (`$raised) { Write-Host '  companion raised the round'; break }; " +
             "if (`$comp.HasExited) { Write-Host ('  companion EXITED ' + `$comp.ExitCode + ' without raising a round - see $compErr; running drill 5 anyway so its own diagnostic is what lands'); break }; " +
             "if ((Get-Date) -gt `$compDeadline) { Write-Host '  companion has not raised a round after 10 minutes - see $compOut; running drill 5 anyway'; break }; " +
             "Start-Sleep -Seconds 10 }"

  # No SOAK_PHASE: join and activate are recorded as done, so this runs vote then exit and writes
  # the full transcript.
  $trackB += New-NodeStep 'scripts/soak/drill5-agent-execute.mjs'

  $trackB += "Write-Host '>>> waiting for drill5-gov-companion (it finalizes, executes and settles the agent exit AFTER drill 5)'"
  $trackB += "if (`$comp) { `$comp.WaitForExit(); Write-Host ('gov-companion exited ' + `$comp.ExitCode + ' - see $compOut') }"
}
Start-Track 'trackB' $trackB | Out-Null

Write-Host @"

===============================================================
Soak is running unattended. Expect ~14 hours, almost all waiting.

  Check progress:  powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1 -Status
  Follow a log:    Get-Content logs\trackA.log -Wait -Tail 20
  Stop everything: powershell -ExecutionPolicy Bypass -File scripts\soak\run-soak.ps1 -Stop

Drill 4 is NOT started here - it is the analyzer, run it at the END once the
sampler has covered a 4h observation window:

  node scripts/soak/drill4-oraclefreeze.mjs

Delete the password files when the run is done - AFTER -Stop, never before. The governance
companion signs with SOAK_SIGNER_ARGS, which names $SignerPasswordFile, and it keeps running
past drill 5 to finalize, execute and settle:
  Remove-Item "$SignerPasswordFile","$AgentPasswordFile" -ErrorAction SilentlyContinue
===============================================================
"@ -ForegroundColor Cyan
