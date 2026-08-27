// @ts-check
/**
 * Drill 5's guards and policy construction, kept pure so they are unit-testable.
 *
 * Extracted from the drill runner for the same reason as `series-analysis.mjs`: the runner
 * executes at import time, so a test importing it would start signing transactions.
 *
 * These two functions are where drill 5's safety actually lives, which is exactly why they
 * should be tested rather than trusted:
 *
 *   - `resolveAgentRunConfig` is the gate. It refuses a raw key in the environment, and it
 *     names EVERY problem at once rather than failing on the first — an operator fixing a
 *     three-item misconfiguration one error at a time is an operator who eventually pastes a
 *     private key into a shell to make it stop.
 *   - `policyFor` is where the forced drawdown trigger is applied. Keeping it visible and
 *     asserted means the report cannot quietly claim a real drawdown was observed.
 */

export const EXECUTE_ENV_VAR = 'AGENT_I_UNDERSTAND_THIS_SPENDS_FUNDS';

/** Chains on which a throwaway key may sign at all. */
export const TESTNET_CHAIN_IDS = new Set([84532, 11155111, 31337, 1337]);

/**
 * Validate the run's environment before anything is decrypted or signed.
 * @param {Record<string, string|undefined>} env
 * @returns {{keystore:string, password:string, apiBaseUrl:string, rpcUrl:string}}
 */
export function resolveAgentRunConfig(env, { defaultRpc = 'https://base-sepolia-rpc.publicnode.com' } = {}) {
  const problems = [];
  if (env[EXECUTE_ENV_VAR] !== 'yes') problems.push(`${EXECUTE_ENV_VAR} is not set to "yes"`);
  if (!env.SOAK_AGENT_KEYSTORE) problems.push('SOAK_AGENT_KEYSTORE (path to the throwaway keystore) is not set');
  if (!env.SOAK_AGENT_KEYSTORE_PASSWORD) problems.push('SOAK_AGENT_KEYSTORE_PASSWORD is not set');
  // A raw key in the environment is a hard refusal, never a fallback — same rule as the
  // Sprint-14 live x402 runner and the reference agent itself.
  if (env.SOAK_AGENT_PRIVATE_KEY || env.AGENT_PRIVATE_KEY) {
    problems.push('refusing to run with a raw private key in the environment — use a keystore');
  }
  if (problems.length) throw new Error('cannot start drill 5:\n  - ' + problems.join('\n  - '));
  return {
    keystore: String(env.SOAK_AGENT_KEYSTORE),
    password: String(env.SOAK_AGENT_KEYSTORE_PASSWORD),
    apiBaseUrl: env.SOAK_API || 'http://127.0.0.1:8402',
    rpcUrl: env.BASE_SEPOLIA_RPC || defaultRpc,
  };
}

/**
 * Policy for a given phase.
 *
 * `requireProvenOperator` is false because the smoke vault's operator has no realized track
 * record yet — leaving it true would make the agent correctly refuse to join, and the drill
 * would prove nothing about the deposit path.
 *
 * @param {'join'|'activate'|'vote'|'exit'} phase
 * @param {{depositUsdc:string, maxDrawdownBps?:number}} p
 */
export function policyFor(phase, { depositUsdc, maxDrawdownBps = 1000 }) {
  const policy = {
    join: {
      requireAttestedOperator: true,
      requireProvenOperator: false,
      minOperatorNetRealizedUsdc: '0',
      maxPerfFeeBps: 1000,
      maxExitFeeBps: 100,
      depositUsdc,
      minFreeCapacityUsdc: depositUsdc,
      maxDepth: 0,
      maxConcurrentVaults: 1,
    },
    exit: { maxDrawdownBps, onOracleFreezeWarning: true, onOperatorNetNegative: false },
    vote: { evaluator: 'naive-drift-band', driftBandBps: 500, maxDriftBandBps: 5000, voteAgainstWhenUnknown: false },
  };
  if (phase === 'exit') {
    // THE FORCED TRIGGER. 1 bp means any non-zero drawdown fires the rule. This proves the
    // agent ACTS on its exit policy; it is not evidence that the vault lost money, and the
    // drill records it as forced so the report cannot imply otherwise.
    policy.exit.maxDrawdownBps = 1;
    policy.exit.forced = true;
  }
  return policy;
}
