/**
 * SECRET AND PERSONAL-DATA SHAPES, factored out of the guard that applies them so the guard's own
 * source is not the only copy — the same reason `claims-shapes.mjs` exists.
 *
 * ## What this covers, and what it deliberately does NOT
 *
 * Every pattern here is **provider-anchored**: a prefix or a framing that a real credential format
 * mandates and ordinary text does not produce. `AKIA` followed by 16 uppercase-alphanumerics is an
 * AWS access key id; a 40-character hex string is a git SHA, an address, a hash, or a test vector,
 * and this repository is full of them.
 *
 * **Mnemonics are NOT detected, and that is a decision rather than an omission.** A BIP-39 phrase is
 * twelve or twenty-four ordinary lowercase English words. Detecting it needs the wordlist and a
 * run-length rule, and against a repo whose prose runs to thousands of lines of dense commentary
 * that yields false positives — and a guard that cries wolf is deleted by the first person it
 * inconveniences, which leaves less coverage than never having built it. The audit that prompted
 * this guard checked all 1,481 commits for mnemonic shapes by hand and found none; that is a
 * point-in-time result, and this file does not pretend to make it continuous. Stated here so the
 * next reader does not assume coverage that is absent.
 *
 * **Bare high-entropy strings are not detected either**, for the same reason: no anchor, no signal.
 *
 * ## Personal data
 *
 * The finding that prompted this guard was not a credential. It was a maintainer's personal Gmail
 * address used as a test fixture — no key, no access, just a private address permanently in a public
 * repository, in a file nobody re-read because it passed. So consumer-mailbox providers are matched
 * by name. Reserved documentation domains (RFC 2606) and the noreply forms are explicitly allowed:
 * those are what a fixture or a commit identity is SUPPOSED to use.
 */

/** Provider-anchored credential shapes. Each entry names what it matches and why it cannot be prose. */
export const SECRET_SHAPES = Object.freeze([
  {
    id: 'pem-private-key',
    // The PEM framing is mandatory and unambiguous; no prose produces it by accident.
    re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY(?: BLOCK)?-----/g,
    why: 'a PEM private-key block',
  },
  {
    id: 'aws-access-key-id',
    re: /\bAKIA[0-9A-Z]{16}\b/g,
    why: 'an AWS access key id (AKIA + 16 uppercase alphanumerics)',
  },
  {
    id: 'github-token',
    // ghp_ / gho_ / ghu_ / ghs_ / ghr_ followed by the token body.
    re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
    why: 'a GitHub personal-access or app token',
  },
  {
    id: 'slack-token',
    re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    why: 'a Slack token',
  },
  {
    id: 'private-key-assignment',
    // An assignment of a 64-hex value to something NAMED a private key. The name is the anchor —
    // a bare 64-hex string is a hash, a salt, a test vector or a commitment, and this repo is full
    // of them, so the value alone must never be the trigger.
    re: /\b(?:private_?key|privkey|secret_?key|mnemonic|seed_?phrase)\b\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{64}\b/gi,
    why: 'a 64-hex value assigned to something named as a private key or seed',
  },
]);

/**
 * Consumer mailbox providers, matched by name.
 *
 * Assembled from a joined list rather than written as one literal so that THIS FILE does not itself
 * contain a string that its own guard would flag — the same self-reference problem
 * `claims-web-prose-truth.test.mjs` solved with a string-literal extractor. A guard whose pattern
 * definition trips the guard forces a blanket self-exemption, and a blanket self-exemption is a hole
 * in the one file most able to hide something.
 */
const CONSUMER_MAILBOX_PROVIDERS = Object.freeze([
  'gmail', 'googlemail', 'outlook', 'hotmail', 'live', 'msn',
  'yahoo', 'ymail', 'aol', 'icloud', 'me', 'mac',
  'proton', 'protonmail', 'pm', 'gmx', 'yandex', 'mail', 'zoho', 'fastmail',
]);

/** A personal mailbox at one of the providers above. */
export const PERSONAL_EMAIL = new RegExp(
  String.raw`\b[A-Za-z0-9._%+-]+@(?:${CONSUMER_MAILBOX_PROVIDERS.join('|')})\.(?:com|co\.uk|de|ru|net|org|me|ch)\b`,
  'gi',
);

/**
 * Addresses that are SUPPOSED to appear: reserved documentation domains (RFC 2606), the GitHub and
 * generic noreply forms a commit identity uses, and obvious placeholder local parts.
 *
 * Matched against the WHOLE address, so it cannot accidentally whitelist a real mailbox that merely
 * contains one of these words.
 */
export const ALLOWED_EMAIL = Object.freeze([
  /@example\.(?:com|net|org)$/i,
  /@(?:test|invalid|localhost|local)$/i,
  /@[A-Za-z0-9.-]*users\.noreply\.github\.com$/i,
  /^noreply@/i,
  /@noreply\./i,
]);

/** True when `addr` is one of the forms a fixture or a commit identity is meant to use. */
export const isAllowedEmail = (addr) => ALLOWED_EMAIL.some((re) => re.test(addr));
