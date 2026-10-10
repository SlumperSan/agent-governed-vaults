/**
 * Types for `packages/chain-config/src/chain-binding.mjs` — issue #204, the ONE place this
 * repository decides whether an RPC answers for the chain something declared. Hand-written: the
 * source is untyped ESM.
 */
export declare class ChainBindingError extends Error {
  constructor(message: string);
}

export declare function assertChainBinding(a: {
  client: { getChainId: () => Promise<number | bigint> };
  declaredChainId: number | string;
  rpc: string;
  declaredBy: string;
}): Promise<{ ok: true; message: string }>;
