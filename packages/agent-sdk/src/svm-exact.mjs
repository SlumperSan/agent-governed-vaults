// @ts-check
/**
 * The CLIENT half of the x402 `exact` scheme on Solana — the sibling of `eip3009.mjs`.
 *
 * ## The asymmetry with the EVM path, which is the whole design
 *
 * `eip3009.mjs` signs an AUTHORIZATION: a typed-data blob saying "this much USDC may move from me to
 * you". The client never builds a transaction, never picks a fee, never sees a blockhash. The server
 * turns the authorization into a call.
 *
 * Here the client builds the transaction ITSELF — an SPL `TransferChecked`, with the facilitator
 * named as fee payer — signs it partially, and hands over the bytes. The facilitator adds the fee
 * payer's signature and submits. So this module needs three things the EVM one does not:
 *
 *   1. A CONNECTION, for a recent blockhash. A Solana transaction is only valid for about two
 *      minutes after the blockhash it names, which is where the replay bound comes from: there is no
 *      nonce in this scheme because the blockhash IS the expiry, and the network refuses a duplicate
 *      signature within that window.
 *   2. THE FACILITATOR'S PUBLIC KEY, which arrives in the challenge as `feePayer`. Without it the
 *      client cannot name the right fee payer and the facilitator refuses the transaction —
 *      `wrong-fee-payer`, by the check added after a review found it verified and then failed at
 *      signing time.
 *   3. THE PAYER'S TOKEN ACCOUNT. Deriving it from the wallet is one call, but the caller knows it
 *      and passing it keeps this module free of the associated-token-address machinery, and free of
 *      the assumption that the payer holds the mint in its canonical account rather than any other.
 *
 * ## What it deliberately does not do
 *
 * It sets no compute-unit price. The facilitator pays the fee and refuses a transaction that tries to
 * raise it (`compute-unit-price-is-paid-by-the-facilitator`), so adding one here would build an
 * envelope guaranteed to be rejected. If a client ever needs priority, the facilitator has to opt in
 * to paying for it, and that is a decision for whoever runs the facilitator.
 */

import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

/**
 * Build the PAYMENT-SIGNATURE envelope for an SVM challenge.
 *
 * @param {Object} p
 * @param {object} p.challenge  the PAYMENT-REQUIRED challenge; needs `asset`, `amount`, `payTo`,
 *                              `feePayer`, `network`, and `decimals`
 * @param {any} p.keypair       the payer's keypair — signs, and is the transfer authority
 * @param {string} p.sourceTokenAccount  the payer's token account for `challenge.asset`
 * @param {{getLatestBlockhash:Function}} p.connection
 * @param {string} [p.tokenProgramId]    override for Token-2022 mints
 * @returns {Promise<object>} the envelope
 */
export async function buildSvmEnvelope({ challenge, keypair, sourceTokenAccount, connection, tokenProgramId }) {
  for (const field of ['asset', 'amount', 'payTo', 'feePayer', 'decimals']) {
    if (challenge?.[field] === undefined || challenge?.[field] === null || challenge?.[field] === '')
      throw new Error(`buildSvmEnvelope: the challenge has no ${field}. An SVM challenge carries the mint, the amount, the destination token account, the facilitator's fee payer and the mint's decimals; an EVM one does not, so a server that has not been taught the difference sends the EVM shape.`);
  }
  const amount = BigInt(challenge.amount);
  if (amount <= 0n) throw new Error(`buildSvmEnvelope: nonpositive amount ${challenge.amount}`);

  const program = new PublicKey(tokenProgramId ?? TOKEN_PROGRAM_ID);
  const tx = new Transaction();
  tx.add(createTransferCheckedInstruction(
    new PublicKey(sourceTokenAccount),
    new PublicKey(challenge.asset),
    new PublicKey(challenge.payTo),
    keypair.publicKey,
    amount,
    Number(challenge.decimals),
    [],
    program,
  ));
  // THE FEE PAYER IS THEIRS, NOT OURS, and it is account 0 of the message the facilitator checks.
  tx.feePayer = new PublicKey(challenge.feePayer);
  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  tx.recentBlockhash = blockhash;

  // Partially signed: the payer authorises the transfer, the fee payer's slot stays empty for the
  // facilitator to fill. `requireAllSignatures: false` is what lets it serialise in that state.
  tx.partialSign(keypair);

  return {
    x402Version: 2,
    scheme: 'exact-svm',
    network: challenge.network,
    transaction: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
  };
}

/**
 * A payer object for `createProtocolClient({ payer })` — the injection point that lets one client
 * speak either scheme without the 402 loop knowing which.
 *
 * @param {Object} p
 * @param {any} p.keypair
 * @param {string} p.sourceTokenAccount
 * @param {{getLatestBlockhash:Function}|string} p.connection  a Connection, or a devnet/mainnet URL
 * @param {string} [p.tokenProgramId]
 */
export function createSvmPayer({ keypair, sourceTokenAccount, connection, tokenProgramId }) {
  const conn = typeof connection === 'string' ? new Connection(connection, 'confirmed') : connection;
  return {
    scheme: 'exact-svm',
    async buildEnvelope({ challenge }) {
      return buildSvmEnvelope({ challenge, keypair, sourceTokenAccount, connection: conn, tokenProgramId });
    },
  };
}
