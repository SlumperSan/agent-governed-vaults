// @ts-check
/**
 * The x402 `exact` scheme on Solana (SVM), as the facilitator side of it.
 *
 * ## How this differs from the EVM path, and why that matters more than it sounds
 *
 * On EVM the client signs an EIP-3009 `transferWithAuthorization` AUTHORIZATION. It never builds a
 * transaction, it pays no gas, and the facilitator's job is to recover a signature and submit a
 * call of its own. The envelope is a signed intent.
 *
 * On Solana the client builds and PARTIALLY SIGNS AN ACTUAL TRANSACTION containing an SPL
 * `TransferChecked`, and the facilitator adds its own signature as the FEE PAYER and submits it.
 * Two consequences follow, and both are the reason this file is longer than the EVM one:
 *
 *   1. THE FACILITATOR PAYS. It needs a funded keypair, so a request that reaches settlement costs
 *      the operator lamports whether or not it succeeds. The EVM facilitator can be keyless behind
 *      an HTTP delegate; this one cannot.
 *   2. THE CLIENT CHOSE EVERY BYTE. The envelope is not an intent that this server then acts on --
 *      it is a whole transaction that this server is being asked to CO-SIGN AND BROADCAST. Anything
 *      it does not check, it endorses. A transaction carrying the expected transfer plus one extra
 *      instruction draining the fee payer is, to a naive facilitator, a valid payment.
 *
 * So verification here is an ALLOW-LIST, not a search. The transaction must contain exactly the
 * instructions this file expects and nothing else. `verifySvmPayment` below returns a reason string
 * for every rejection, and every one of those reasons has a test.
 *
 * ## What is deliberately NOT derived
 *
 * The destination token account is read from configuration, not derived from the payTo wallet.
 * Deriving an associated token address is a one-line call, but it would mean this server computes
 * where money should go from a value that arrives in the request; reading it from config means the
 * operator states it once, out of band, and a mismatch is a rejection rather than a redirect.
 *
 * ## Devnet only, for now
 *
 * The owner's decision of 2026-09-09: build and prove this on `solana-devnet`, where SOL is free
 * and the keypair costs nothing to fund, and hold the key themselves. Nothing here reads a file or
 * a repository secret -- the keypair arrives as an env var and is parsed in `serve.mjs`. There is
 * no mainnet keypair and this file does not assume one exists.
 *
 * NOTHING HERE PUTS KEY MATERIAL IN A STRING THAT LEAVES THE PROCESS. That is a property of the
 * code and not a hope: `keypairFromEnv` returns a shape code on failure rather than the parser's
 * message, because V8 quotes its input back and the input is the key. The test below feeds a real
 * generated key with a deliberate typo and asserts no byte of it appears in the reason.
 */

import { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, decodeTransferCheckedInstruction } from '@solana/spl-token';

/** The SPL `TransferChecked` discriminator, for the shape check before decoding. */
const TRANSFER_CHECKED = 12;

const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';

/** ComputeBudget instruction discriminators, by the byte that leads their data. */
const SET_COMPUTE_UNIT_LIMIT = 2;
const SET_COMPUTE_UNIT_PRICE = 3;

/**
 * What may appear alongside the transfer.
 *
 * COMPUTE BUDGET IS NOT WHOLESALE BENIGN, AND THE FIRST DRAFT OF THIS FILE SAID IT WAS. The comment
 * read "it moves nothing and cannot", which is true of `SetComputeUnitLimit` and FALSE of
 * `SetComputeUnitPrice`: the priority fee is `limit × price`, and on this path the fee payer is
 * THIS SERVER. A client could have attached `setComputeUnitPrice({microLamports: 5_000_000})` to an
 * otherwise perfect $0.01 payment and billed the facilitator's keypair for the privilege — the
 * exact shape the allow-list exists to stop, waved through by an allow-list entry.
 *
 * So the rule is per instruction, not per program. A limit is allowed: it caps compute units, and
 * with the price left at its default of zero it costs the fee payer nothing. A price is refused. A
 * client that wants faster inclusion is asking somebody else to pay for it, and the somebody else
 * is the operator running this process.
 *
 * @param {{programId:string, data:Uint8Array}} ix
 * @returns {string|null} a rejection reason, or null if the instruction may stand
 */
const rejectNonTransfer = (ix) => {
  if (ix.programId !== COMPUTE_BUDGET) return `unexpected-program:${ix.programId}`;
  if (ix.data[0] === SET_COMPUTE_UNIT_LIMIT) return null;
  if (ix.data[0] === SET_COMPUTE_UNIT_PRICE) return 'compute-unit-price-is-paid-by-the-facilitator';
  return `unexpected-compute-budget-instruction:${ix.data[0]}`;
};

/**
 * Decode a base64 transaction.
 *
 * ONE PARSER, NOT TWO. The first draft tried `VersionedTransaction.deserialize` and fell back to
 * the legacy `Transaction.from`. Measured: `VersionedTransaction.deserialize` accepts LEGACY wire
 * bytes too and reports `message.version === 'legacy'`, so the fallback never ran for any
 * well-formed input and existed only to be believed. It is gone, and the version is read from the
 * message rather than inferred from which parser won -- which is the thing a reader of this file
 * actually wants to know.
 *
 * @param {string} b64
 * @returns {{ok:true, tx:any, version:'legacy'|number}|{ok:false, reason:string}}
 */
export function decodeTransaction(b64) {
  if (typeof b64 !== 'string' || b64.length === 0) return { ok: false, reason: 'no-transaction' };
  let raw;
  try {
    raw = Buffer.from(b64, 'base64');
  } catch {
    return { ok: false, reason: 'transaction-not-base64' };
  }
  if (raw.length === 0) return { ok: false, reason: 'transaction-empty' };
  try {
    const tx = VersionedTransaction.deserialize(raw);
    return { ok: true, tx, version: tx.message.version };
  } catch {
    return { ok: false, reason: 'transaction-undecodable' };
  }
}

/**
 * The instructions of a decoded transaction, as `{programId, accounts, data}`.
 *
 * `staticAccountKeys` is the right list even for a v0 message: an instruction whose accounts come
 * from an address-lookup table would index PAST it, and `keys[i]` is then `undefined`. That is not
 * a gap -- an undefined key matches nothing, so such a transaction is REFUSED rather than silently
 * mis-read. A payment that needs a lookup table is a payment this facilitator does not accept.
 *
 * WHICH reason it is refused with depends on where the undefined key lands, and this comment used to
 * assert one of them: it said `unexpected-program:undefined`. Measured, a lookup-table transfer is
 * refused as `transfer-undecodable`, because the token program id itself is usually static and it is
 * the ACCOUNTS that index past the list. Both are refusals; only one was true, and naming the wrong
 * one in a security comment is how a future reader concludes the wrong branch is covered.
 *
 * @param {{tx:any}} decoded
 * @returns {{programId:string, accounts:string[], data:Uint8Array}[]}
 */
export function instructionsOf({ tx }) {
  const keys = tx.message.staticAccountKeys.map((/** @type {any} */ k) => k.toBase58());
  return tx.message.compiledInstructions.map((/** @type {any} */ ix) => ({
    programId: keys[ix.programIdIndex],
    accounts: ix.accountKeyIndexes.map((/** @type {number} */ i) => keys[i]),
    data: Uint8Array.from(ix.data),
  }));
}

/**
 * Does this transaction pay exactly what the challenge asked for, and nothing else?
 *
 * THE CHECK IS AN ALLOW-LIST, AND IT IS PER INSTRUCTION RATHER THAN PER PROGRAM. Every instruction
 * must be either the one expected transfer or one `rejectNonTransfer` lets stand. That is the whole
 * security posture of this file: the caller wrote the transaction and this server is about to sign
 * it, so an instruction nobody recognised is a rejection and never a shrug — and a program that is
 * benign in most of its instructions is not benign in all of them.
 *
 * @param {{price:{asset:string, amount:string, payTo:string, network?:string}}} challenge
 * @param {{transaction?:string, x402Version?:number}} envelope
 * @param {{destinationTokenAccount:string, feePayer:string}} cfg
 * @returns {{ok:true, amount:bigint, source:string, authority:string}|{ok:false, reason:string}}
 */
export function verifySvmPayment(challenge, envelope, cfg) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, reason: 'no-envelope' };
  if (envelope.x402Version !== 2) return { ok: false, reason: 'bad-version' };

  const price = challenge?.price;
  if (!price) return { ok: false, reason: 'no-price' };
  let want;
  try {
    want = BigInt(price.amount ?? '');
  } catch {
    return { ok: false, reason: 'bad-price-amount' };
  }
  if (want <= 0n) return { ok: false, reason: 'nonpositive-price' };

  // The network is bound HERE as well as in `checkEnvelopeAgainstPrice`, deliberately: this function
  // is exported and reachable on its own, and a facilitator that signs whatever it is handed should
  // not depend on a caller having checked first.
  //
  // A PRICE THAT NAMES NO NETWORK IS REFUSED rather than waved through. The guard was
  // `if (price.network && …)` and its comment called it unconditional, which is the pattern this
  // file has now been rejected over three times. `resolveApiConfig` always defaults `network`, so no
  // production path reached the hole — but "unreachable today" is not what the comment claimed, and
  // this function's whole contract is that it endorses nothing it did not check.
  if (!price.network) return { ok: false, reason: 'price-names-no-network' };
  if ((envelope.network ?? '').toLowerCase() !== String(price.network).toLowerCase())
    return { ok: false, reason: `wrong-network:${envelope.network ?? 'none'}` };

  const decoded = decodeTransaction(envelope.transaction ?? '');
  if (!decoded.ok) return decoded;

  // THE FEE PAYER IS ACCOUNT 0, AND IT HAS TO BE US. Solana puts the fee payer first in the account
  // keys, always. Without this check a transaction naming somebody else as fee payer VERIFIED, and
  // only fell over later inside `sign()` with `Cannot sign with non signer key …` — reported as
  // `settlement-error:`, which in this repository means "we could not tell whether you paid". We
  // could tell perfectly well: the envelope is malformed. #173, #179 and #183 are all the same
  // lesson about exactly that confusion, and this is it appearing a fourth time in a new file.
  const feePayer = decoded.tx.message.staticAccountKeys[0]?.toBase58();
  if (feePayer !== cfg.feePayer) return { ok: false, reason: `wrong-fee-payer:${feePayer ?? 'none'}` };

  const ixs = instructionsOf(decoded);
  if (ixs.length === 0) return { ok: false, reason: 'no-instructions' };

  const transfers = [];
  for (const ix of ixs) {
    const isToken = ix.programId === TOKEN_PROGRAM_ID.toBase58() || ix.programId === TOKEN_2022_PROGRAM_ID.toBase58();
    if (isToken) {
      if (ix.data[0] !== TRANSFER_CHECKED) return { ok: false, reason: 'token-instruction-is-not-transferchecked' };
      transfers.push(ix);
      continue;
    }
    const rejection = rejectNonTransfer(ix);
    if (rejection) return { ok: false, reason: rejection };
  }

  if (transfers.length === 0) return { ok: false, reason: 'no-transfer' };
  if (transfers.length > 1) return { ok: false, reason: 'more-than-one-transfer' };

  const ix = transfers[0];
  let decodedTransfer;
  try {
    decodedTransfer = decodeTransferCheckedInstruction(
      {
        programId: new PublicKey(ix.programId),
        keys: ix.accounts.map((a, i) => ({ pubkey: new PublicKey(a), isSigner: i === 3, isWritable: i !== 1 && i !== 3 })),
        data: Buffer.from(ix.data),
      },
      new PublicKey(ix.programId),
    );
  } catch {
    return { ok: false, reason: 'transfer-undecodable' };
  }

  const mint = decodedTransfer.keys.mint.pubkey.toBase58();
  const dest = decodedTransfer.keys.destination.pubkey.toBase58();
  const source = decodedTransfer.keys.source.pubkey.toBase58();
  const authority = decodedTransfer.keys.owner.pubkey.toBase58();
  const amount = BigInt(decodedTransfer.data.amount);

  if (mint !== price.asset) return { ok: false, reason: 'wrong-mint' };
  if (dest !== cfg.destinationTokenAccount) return { ok: false, reason: 'wrong-destination' };
  if (amount !== want) return { ok: false, reason: 'wrong-amount' };
  // The payer must not be the thing being paid, and must not be this server.
  if (source === dest) return { ok: false, reason: 'source-is-destination' };
  if (authority === cfg.feePayer) return { ok: false, reason: 'authority-is-fee-payer' };

  // THE AUTHORITY MUST ACTUALLY HAVE SIGNED, AND THIS IS WHERE THAT IS ESTABLISHED. Everything
  // above reads what the transaction SAYS; none of it reads who signed it. A review built a
  // TransferChecked the payer never signed and this function returned `{ok:true}` — after which the
  // facilitator adds its own signature and broadcasts. The RPC's sig-verify does reject it at
  // preflight, so no lamports move; the damage is the reason string. The client is told
  // `settlement-error:`, and in this repository that means "we could not tell whether you paid" —
  // the exact confusion `wrong-fee-payer` was added a few lines above to end, reappearing one
  // function down. #173, #179, #183.
  //
  // Solana's message header says accounts [0, numRequiredSignatures) are the signers, in order, and
  // `tx.signatures[i]` is that account's signature. An unsigned slot is 64 zero bytes.
  //
  // EXACTLY TWO SIGNATURES, not "at least two". The facilitator pays 5000 lamports PER SIGNATURE, so
  // a client padding the account list with extra signers is spending this server's money; a review
  // drove `numRequiredSignatures` to 10 and the verdict was still `{ok:true}`. This scheme needs the
  // fee payer and the transfer authority and nobody else, and `authority !== feePayer` is enforced
  // above, so two is the exact count — which makes the fee this facilitator can be charged a
  // constant rather than something a client chooses.
  const header = decoded.tx.message.header;
  const required = Number(header?.numRequiredSignatures ?? 0);
  if (required !== 2) return { ok: false, reason: `expected-two-signers-got:${required}` };
  const keys = decoded.tx.message.staticAccountKeys.map((/** @type {any} */ k) => k.toBase58());
  const authorityIndex = keys.indexOf(decodedTransfer.keys.owner.pubkey.toBase58());
  if (authorityIndex < 0 || authorityIndex >= required)
    return { ok: false, reason: 'transfer-authority-is-not-a-signer' };
  const authoritySig = decoded.tx.signatures?.[authorityIndex];
  if (!authoritySig || authoritySig.every((/** @type {number} */ b) => b === 0))
    return { ok: false, reason: 'transfer-authority-did-not-sign' };

  return { ok: true, amount, source, authority };
}

/**
 * The facilitator itself: verify, co-sign as fee payer, submit, confirm.
 *
 * `connection` is injected so every test in this file runs with no network and no key. The shape it
 * needs is small on purpose -- `sendRawTransaction`, `confirmTransaction`, `getLatestBlockhash` --
 * and a real `Connection` satisfies it.
 *
 * @param {{connection:any, keypair:any, destinationTokenAccount:string, commitment?:string}} cfg
 */
export function createSvmFacilitator({ connection, keypair, destinationTokenAccount, commitment = 'confirmed' }) {
  const feePayer = keypair.publicKey.toBase58();
  return {
    scheme: 'exact-svm',
    // PUBLISHED, because the 402 challenge has to name it and nothing else knows it. It is a public
    // key: publishing it is what lets a client build a transaction this facilitator will accept.
    feePayer,
    async verifyAndSettle(challenge, envelope) {
      const verdict = verifySvmPayment(challenge, envelope, { destinationTokenAccount, feePayer });
      if (!verdict.ok) return { ok: false, reason: verdict.reason };

      const decoded = decodeTransaction(envelope.transaction);
      if (!decoded.ok) return { ok: false, reason: decoded.reason };

      try {
        // SIGN LAST AND SIGN ONLY WHAT WAS VERIFIED. The transaction re-decoded here is the same
        // bytes `verifySvmPayment` read; nothing between the two steps can substitute it.
        decoded.tx.sign([keypair]);
        const raw = decoded.tx.serialize();
        const signature = await connection.sendRawTransaction(raw, { skipPreflight: false, preflightCommitment: commitment });
        const confirmation = await connection.confirmTransaction(signature, commitment);
        if (confirmation?.value?.err) return { ok: false, reason: `settlement-failed:${JSON.stringify(confirmation.value.err)}` };
        return { ok: true, receiptId: signature };
      } catch (err) {
        // A transport failure is NOT a rejection of the payment, and saying so is the difference
        // between "you did not pay" and "we could not tell". The gate treats both as a 402, but the
        // reason string is what an operator reads at 3am.
        return { ok: false, reason: `settlement-error:${String(err?.message ?? err).slice(0, 200)}` };
      }
    },
  };
}

/**
 * Build the keypair from the env var the operator sets. Accepts the two shapes a Solana operator
 * actually has: the 64-byte secret key as a JSON array (what `solana-keygen` writes), or base58.
 *
 * IT IS NEVER READ FROM A FILE IN THE REPOSITORY and never logged. The owner holds this key; the
 * process receives it and nothing else does.
 *
 * @param {string|undefined} raw
 * @returns {{ok:true, keypair:any}|{ok:false, reason:string}}
 */
export function keypairFromEnv(raw) {
  if (!raw || raw.trim() === '') return { ok: false, reason: 'no-keypair' };
  const text = raw.trim();
  try {
    if (text.startsWith('[')) {
      const bytes = Uint8Array.from(JSON.parse(text));
      if (bytes.length !== 64) return { ok: false, reason: `keypair-wrong-length:${bytes.length}` };
      return { ok: true, keypair: Keypair.fromSecretKey(bytes) };
    }
    return { ok: true, keypair: Keypair.fromSecretKey(base58Decode(text)) };
  } catch (err) {
    // THE PARSER'S MESSAGE MUST NOT ESCAPE, AND THE FIRST DRAFT LET IT. V8 quotes a window of its
    // input back in a SyntaxError -- `Unexpected token 'x', "[x254,96,74"... is not valid JSON` --
    // and for a secret key that window IS secret-key bytes. It reached `serve.mjs`'s error and from
    // there `log.error('startup.failed')`. A review found it against three separate comments in
    // this repository claiming the key is never logged, and a commit message claiming a test proved
    // it; the test only covered the wrong-length path, which cannot echo input.
    //
    // So the reason is a SHAPE, derived from the input's form and never from its content. It says
    // enough to fix a typo -- which of the two accepted encodings was attempted -- and nothing an
    // attacker reading logs can use.
    const shape = String(raw).trim().startsWith('[') ? 'json-array' : 'base58';
    void err;
    return { ok: false, reason: `keypair-unparseable:${shape}` };
  }
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** base58 → bytes. Small, and here so a keypair string does not need a second dependency. */
export function base58Decode(s) {
  let num = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error(`invalid base58 character '${ch}'`);
    num = num * 58n + BigInt(i);
  }
  const bytes = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Leading '1's are leading zero bytes, and dropping them changes the key.
  for (const ch of s) {
    if (ch !== '1') break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

export { Connection };
