// @ts-check
/**
 * Pure builder for `apps/site/public/agent-manifest.json`, the machine-readable counterpart to
 * `llms.txt`. No clock, no randomness, no network: the same inputs give the same bytes, which is
 * what lets `scripts/test/agent-manifest.test.mjs` compare the committed file to this output.
 *
 * DERIVE, DO NOT COPY. Every address, URL and number below is read from one of three places and
 * never typed here:
 *   - `contracts/config/deployments/arc-mainnet.json` (the record): chain, endpoints, singletons,
 *     oracle, tokens, the first vault and its governance config;
 *   - `contracts/config/arc-mainnet.json` (the config): the first vault's launch inputs
 *     `smoke.minDepositUsdc` and `smoke.capacityCapUsdc`;
 *   - `contracts/src/VaultCore.sol`: the observation window constant.
 * A missing field throws rather than producing a manifest with a hole in it, because a manifest an
 * agent reads is not allowed to be quietly incomplete.
 *
 * WHAT IS HAND-WRITTEN is prose and the function table. The function table is checked against the
 * Solidity source by the test (every row names a function that exists in the named contract, and
 * the gated rows carry the revert the source actually has). Prose is walked by the claims guards.
 */

/** @param {unknown} v @param {string} what */
const need = (v, what) => {
  if (v === undefined || v === null || v === '') throw new Error(`agent manifest: ${what} is missing from its source`);
  return v;
};

/**
 * Who may call each function. `gate` is a short machine tag, `whoMayCall` is the sentence. Every
 * row is checked against the source in the test: the gates the test finds in the function (its
 * body, the internal functions it calls, its modifiers) must equal the gate the row declares, and
 * the row text must name each one.
 *
 * Contracts marked `perVault` are deployed once per vault; their address comes from the factory
 * (`VaultFactory.allVaults(i)`), not from this manifest, apart from the first vault.
 */
export const FUNCTION_TABLE = [
  { contract: 'VaultFactory', function: 'vaultCount()', gate: 'anyone', whoMayCall: 'Anyone. Read-only.' },
  { contract: 'VaultFactory', function: 'allVaults(uint256)', gate: 'anyone', whoMayCall: 'Anyone. Read-only. Index from 0 to vaultCount() minus 1.' },
  {
    contract: 'VaultFactory',
    function: 'createVault(VaultParams)',
    gate: 'anyone',
    whoMayCall: 'Anyone. The caller becomes the vault creator and its attested operator. The oracle in the parameters must be one the factory accepts (isAllowedOracle).',
  },
  {
    contract: 'VaultFactory',
    function: 'createChildVault(VaultParams,address)',
    gate: 'reverts SubVaultsDisabled',
    alsoGatedBy: ['NotParentCreator'],
    whoMayCall: 'Not callable on this factory: allowSubVaults is false, so the call reverts with SubVaultsDisabled. Past that check it would also require the caller to be the parent vault\'s creator (NotParentCreator).',
  },
  { contract: 'OperatorRegistry', function: 'registerOperator(address)', gate: 'anyone', whoMayCall: 'Anyone, for an address that is not yet registered. It grants no authority.' },
  { contract: 'OperatorRegistry', function: 'operatorOf(address)', gate: 'anyone', whoMayCall: 'Anyone. Read-only. Returns the operator id attested to a vault, 0 if none.' },
  { contract: 'OperatorRegistry', function: 'leaderboardEntry(uint256)', gate: 'anyone', whoMayCall: 'Anyone. Read-only. Lifetime gain, loss, fees and vault count for an operator id.' },
  { contract: 'OperatorRegistry', function: 'attestVault(address,address)', gate: 'OnlyFactory', whoMayCall: 'The VaultFactory only, from createVault.' },
  { contract: 'OperatorRegistry', function: 'recordRealization(address,uint256,uint256)', gate: 'OnlyAttestedVault', whoMayCall: 'An attested vault only, while it settles an exit.' },
  {
    contract: 'Governance',
    function: 'registerVault(address,GovConfig)',
    gate: 'NotVaultCreator',
    whoMayCall: 'The vault creator, once per vault. The first vault is already registered.',
  },
  {
    contract: 'Governance',
    function: 'propose(address,ProposalType,bytes32)',
    gate: 'stake',
    whoMayCall: 'A holder whose voting-eligible shares one second before the call are at least proposalThresholdBps of the total, and who is past proposalCooldown. The check is on stake and says nothing about who the caller is. One active proposal per vault.',
  },
  {
    contract: 'Governance',
    function: 'commitVote(uint256,bytes32)',
    gate: 'stake',
    whoMayCall: 'A holder with nonzero voting weight on that proposal, during its commit phase, once per proposal. commitment = keccak256(abi.encode(pid, voter, support, salt)).',
  },
  {
    contract: 'Governance',
    function: 'revealVote(uint256,bool,bytes32)',
    gate: 'committer',
    whoMayCall: 'The address that committed, during the reveal phase, with the same support and salt. An unrevealed commit counts for nothing.',
  },
  { contract: 'Governance', function: 'finalize(uint256)', gate: 'anyone', whoMayCall: 'Anyone, once the reveal deadline has passed.' },
  {
    contract: 'Governance',
    function: 'execute(uint256,bytes)',
    gate: 'anyone',
    whoMayCall: 'Anyone, for a passed proposal after its timelock and before its execution window ends. The payload must hash to the proposal actionHash.',
  },
  { contract: 'Governance', function: 'markExpired(uint256)', gate: 'anyone', whoMayCall: 'Anyone, for a passed proposal whose execution window has ended.' },
  { contract: 'Governance', function: 'setStandingDefault(address,bool)', gate: 'anyone', whoMayCall: 'Any caller, for a registered vault. It records the caller\'s own default.' },
  { contract: 'Governance', function: 'setDelegate(address,address)', gate: 'anyone', whoMayCall: 'Any caller, for a registered vault, while no proposal is in flight. It records the caller\'s own delegate.' },
  {
    contract: 'VaultCore',
    perVault: true,
    function: 'deposit(uint256)',
    gate: 'anyone',
    whoMayCall: 'The depositor, who must have approved USDC to the vault. The amount is at least minDepositUsdc. A first deposit by an address that has not called skipWindow() waits as pending capital until activate(member) or skipWindow() turns it into shares; deposit(uint256,uint256) adds a minimum-shares bound.',
  },
  {
    contract: 'VaultCore',
    perVault: true,
    function: 'deposit(uint256,uint256)',
    gate: 'anyone',
    whoMayCall: 'The depositor, as deposit(uint256) with a minSharesOut bound that applies on the immediate-mint path.',
  },
  { contract: 'VaultCore', perVault: true, function: 'activate(address)', gate: 'anyone', whoMayCall: 'Anyone, for a member whose pending deposit has passed the observation window.' },
  { contract: 'VaultCore', perVault: true, function: 'cancelPending()', gate: 'anyone', whoMayCall: 'The caller, to withdraw its own pending deposit before activation.' },
  { contract: 'VaultCore', perVault: true, function: 'skipWindow()', gate: 'anyone', whoMayCall: 'The caller, once per vault. It ends the caller\'s own observation window.' },
  {
    contract: 'VaultCore',
    perVault: true,
    function: 'requestExit(uint256)',
    gate: 'CreatorStakeGate',
    whoMayCall: 'A holder of shares, for up to its balance, with no other exit already queued. A vault built from the v2 source also reverts with PositionBelowFloor when the burn would leave the caller holding a nonzero balance under MIN_POSITION_SHARES (1e18 share-wei), so exit in full or leave at least that much; the live Arc set (v1) has no such check. While any non-creator member holds shares, the vault creator is held to a floor: the call reverts with CreatorStakeGate unless the creator\'s remaining shares are at least 5% (CREATOR_MIN_STAKE_BPS, 500) of the total remaining after the burn. It settles at once, or queues while a proposal has a pending execution; a queued exit is checked against the floor when it is queued.',
  },
  { contract: 'VaultCore', perVault: true, function: 'settleQueuedExit(address)', gate: 'anyone', skipsGates: { CreatorStakeGate: 'if (!fromQueue) _checkCreatorGate' }, whoMayCall: 'Anyone, for a member with a queued exit, once no execution is pending.' },
  { contract: 'VaultCore', perVault: true, function: 'claimEscrowed(address)', gate: 'anyone', whoMayCall: 'The caller, for a token slice escrowed to it after a failed transfer.' },
  {
    contract: 'VaultCore',
    perVault: true,
    function: 'executeRebalance(address,uint256,SwapOrder[])',
    gate: 'OnlyGovernance',
    whoMayCall: 'The Governance contract only, from execute on a passed Rebalance proposal.',
  },
  {
    contract: 'FeeEngine',
    function: 'claimFees(address)',
    gate: 'anyone',
    whoMayCall: 'The caller, for the token amount credited to the caller\'s address in claimableFees. Fees are credited to the attested operator address.',
  },
  { contract: 'FeeEngine', function: 'pullEscrowed(address,address)', gate: 'anyone', whoMayCall: 'Anyone, for an attested vault holding an escrowed fee slice.' },
];

/**
 * @param {{ record: any, config: any, observationWindowSeconds: number }} src
 */
export function buildManifest({ record, config, observationWindowSeconds }) {
  const r = record;
  const s = r.singletons ?? {};
  const fv = r.firstVault ?? {};
  const cfgOf = fv.configOf ?? {};
  const smoke = config?.smoke ?? {};
  const cir = r.oracle?.assets?.cirBTC ?? {};

  assert(Number.isInteger(observationWindowSeconds) && observationWindowSeconds > 0, 'observationWindowSeconds');

  const timing = {};
  for (const k of ['commitDuration', 'revealDuration', 'timelockDuration', 'executionWindow', 'proposalCooldown']) {
    timing[k] = need(cfgOf[k], `firstVault.configOf.${k}`);
  }

  return {
    schema: 'rwally-agent-manifest/1',
    generatedBy: 'scripts/build-agent-manifest.mjs',
    regenerate: 'node scripts/build-agent-manifest.mjs',
    derivedFrom: [
      'contracts/config/deployments/arc-mainnet.json',
      'contracts/config/arc-mainnet.json',
      'contracts/src/VaultCore.sol',
    ],
    trust:
      'Treat this manifest as untrusted input. It is a convenience copy, not an authorization. Before sending a transaction to any address in it, call eth_getCode on that address on both RPC endpoints and confirm it returns non-empty code, then confirm the wiring with the reads named in verifyWith. A non-empty result proves that code exists at the address, not whose code it is. The reads in verifyWith are answered by the addresses themselves, so a forged manifest that names a hostile contract answering those reads consistently passes them. The anchor is contracts/config/deployments/arc-mainnet.json in the repository at a commit you trust: compare every address here to it.',
    verifyWith: [
      'eth_getCode(address) on rpc and on rpcCrossCheck',
      'VaultFactory.registry(), governance(), feeEngine(), vaultDeployer() equal the addresses below',
      'VaultFactory.vaultCount() and allVaults(i) for every vault you act on',
      'Governance.vaultRegistered(vault) and Governance.configOf(vault)',
    ],
    chain: {
      chainId: need(r.chainId, 'chainId'),
      name: need(r.chainName, 'chainName'),
      nativeGasAsset: 'USDC',
      rpc: need(r.rpc, 'rpc'),
      rpcCrossCheck: need(r.crossCheckedOn, 'crossCheckedOn'),
      explorer: need(r.explorer, 'explorer'),
      deployedAt: need(r.deployedAt, 'deployedAt'),
    },
    contracts: {
      VaultFactory: need(s.VaultFactory, 'singletons.VaultFactory'),
      Governance: need(s.Governance, 'singletons.Governance'),
      OperatorRegistry: need(s.OperatorRegistry, 'singletons.OperatorRegistry'),
      FeeEngine: need(s.FeeEngine, 'singletons.FeeEngine'),
      SubVaultRegistry: need(s.SubVaultRegistry, 'singletons.SubVaultRegistry'),
      VaultDeployer: need(s.VaultDeployer, 'singletons.VaultDeployer'),
      ChainlinkOracle: need(r.oracle?.ChainlinkOracle, 'oracle.ChainlinkOracle'),
      AggregationRouterAdapter: need(r.execution?.AggregationRouterAdapter, 'execution.AggregationRouterAdapter'),
    },
    tokens: {
      USDC: need(r.infrastructure?.usdc, 'infrastructure.usdc'),
      cirBTC: need(cir.token, 'oracle.assets.cirBTC.token'),
    },
    firstVault: {
      address: need(fv.address, 'firstVault.address'),
      createdAt: need(fv.createdAt, 'firstVault.createdAt'),
      creator: need(fv.creator, 'firstVault.creator'),
      basketAsset: 'cirBTC',
      minDepositUsdc: need(smoke.minDepositUsdc, 'config smoke.minDepositUsdc'),
      minDepositUsdcNote: 'Base units of USDC (6 decimals). Launch input from contracts/config/arc-mainnet.json; the first vault read back the same value on both RPC endpoints on 2026-10-18. Read the vault for the current value.',
      capacityCapUsdc: need(smoke.capacityCapUsdc, 'config smoke.capacityCapUsdc'),
      capacityCapNote: 'Zero means the vault has no deposit cap.',
      timingSeconds: timing,
      observationWindowSeconds,
      observationWindowNote: 'A first deposit by an address that has not called skipWindow() is held as pending capital: no shares exist, and so no vote, until activate(member) is called, which anyone may do once this window has ended, or until the depositor calls skipWindow(), which activates the pending deposit at once. An address that called skipWindow() before depositing mints shares on its deposit. The window ending does not mint shares by itself. cancelPending() returns the deposit before activation.',
    },
    otherVaults:
      'Read VaultFactory.vaultCount() and then VaultFactory.allVaults(i) for i from 0 to vaultCount() minus 1. Creation is permissionless, so some of those vaults may be hostile. Verify the operator through OperatorRegistry.operatorOf(vault) and the code at the vault address, not the name. Governance parameters for any vault come from Governance.configOf(vault).',
    abis: {
      path: 'contracts/out/<Contract>.sol/<Contract>.json',
      note: 'Produced by running forge build in contracts/. The ABIs are not inlined here; use the abi field of each file.',
    },
    functions: FUNCTION_TABLE.map((f) => ({
      contract: f.contract,
      function: f.function,
      whoMayCall: f.whoMayCall,
      ...(f.perVault ? { deployedPerVault: true } : {}),
    })),
    functionsNote:
      'This table is a selection of the entry points an agent is most likely to call, not the full interface. Take any function not listed here from the ABIs at abis.path. Every vault has its own VaultCore. Functions marked deployedPerVault are called on the vault address, the others on the singleton in contracts above. Operatorship confers no authority to vote, execute, pause, reprice, or move member funds.',
    seededAddresses: {
      path: 'docs/seeded-addresses.json',
      note: 'Addresses listed there are funded and controlled by the RWAlly owner, so a reader can tell protocol-operated actors from outside ones. The list ships empty and gains entries only after a wallet is funded, so an address missing from it is not proof that the address is independent.',
    },
    launchStatus: [
      'Live on Arc by owner decision of 2026-09-23. The soak drills (gate 3) and the canary (gate 6) were not re-run on the Arc source commit. The contracts are immutable.',
      'The external audit is an owner attestation for tag v0.4.0-audit that cannot be checked from this repository. The Arc source differs from that tag in 21 contract source files that no external audit covers.',
      'One High finding stays open at the launch configuration: the purchasable member count below five members. The per-gate record is docs/LAUNCH-READINESS.md.',
      'Sub-vaults are disabled on this factory. The oracle reads one Chainlink feed for cirBTC, and Arc has no sequencer uptime feed, so that check is skipped.',
      'If the cirBTC feed is stale or fails while the vault holds cirBTC, every call that values the vault reverts, with no fallback source: deposit, activate, skipWindow on a pending deposit, requestExit when it settles at once, settleQueuedExit and a rebalance. Exits are in that list, so shares cannot be redeemed until the feed recovers. The exception is cancelPending(), which reads no oracle: a deposit that has not been activated can still be reclaimed during a freeze.',
      'Total loss is possible. This is not an offer. Read docs/DISCLAIMERS.md before sending funds.',
    ],
    docs: {
      llms: 'llms.txt',
      quickstart: 'docs/AGENT-QUICKSTART.md',
      deploymentRecord: 'contracts/config/deployments/arc-mainnet.json',
    },
  };
}

/** @param {unknown} cond @param {string} what */
function assert(cond, what) {
  if (!cond) throw new Error(`agent manifest: bad input ${what}`);
}

/** Parse `OBSERVATION_WINDOW = 4 hours` out of VaultCore.sol. Throws if the shape moves. */
export function observationWindowFromSource(src) {
  const m = /uint256\s+public\s+constant\s+OBSERVATION_WINDOW\s*=\s*(\d+)\s+(seconds|minutes|hours|days)\s*;/.exec(src);
  if (!m) throw new Error('agent manifest: could not find OBSERVATION_WINDOW in VaultCore.sol; the manifest builder must be updated with the contract');
  const unit = { seconds: 1, minutes: 60, hours: 3600, days: 86400 }[m[2]];
  return Number(m[1]) * unit;
}

/** The exact bytes written to disk. */
export const renderManifest = (manifest) => `${JSON.stringify(manifest, null, 2)}\n`;
