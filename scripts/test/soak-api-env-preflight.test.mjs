// @ts-check
/**
 * Tests for scripts/soak/preflight-api-env.mjs — the check that must catch, before anything is
 * spawned, what previously only surfaced as a crashed api process the launcher reported as
 * "started".
 *
 * `checkApiEnv` is exercised directly (an in-process import, since it is a thin, side-effect-free
 * wrapper around the REAL `resolveApiConfig` from apps/api/src/serve.mjs — not a copy of its
 * rules). The script's exit-code contract is exercised for real, as a subprocess, because that is
 * the interface run-soak.ps1 actually depends on (`$LASTEXITCODE -ne 0`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkApiEnv } from '../soak/preflight-api-env.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'soak', 'preflight-api-env.mjs');

const OK_ENV = {
  PRICE_ASSET: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  PRICE_PAYTO: '0x0f80606a2283fD9C67cE2eEC79B90E95907F9f35',
};

test('checkApiEnv: the exact measured defect — PRICE_ASSET and PRICE_PAYTO both missing', () => {
  const r = checkApiEnv({});
  assert.equal(r.ok, false);
  assert.match(r.message, /missing required env: PRICE_ASSET, PRICE_PAYTO/,
    'must be resolveApiConfig\'s own message, unedited — this is the whole point of calling it rather than hand-copying its rules');
});

test('checkApiEnv: a complete, valid env passes', () => {
  const r = checkApiEnv(OK_ENV);
  assert.equal(r.ok, true);
  assert.equal(r.message, undefined);
});

test('checkApiEnv: a malformed PRICE_ASSET is caught too, not just a missing one', () => {
  const r = checkApiEnv({ ...OK_ENV, PRICE_ASSET: 'not-an-address' });
  assert.equal(r.ok, false);
  assert.match(r.message, /PRICE_ASSET is not an 0x address/);
});

test('checkApiEnv: FACILITATOR=http without FACILITATOR_URL is caught — the contract is not just the two price vars', () => {
  const r = checkApiEnv({ ...OK_ENV, FACILITATOR: 'http' });
  assert.equal(r.ok, false);
  assert.match(r.message, /FACILITATOR=http requires FACILITATOR_URL/);
});

// ── the actual subprocess contract run-soak.ps1 depends on ($LASTEXITCODE) ───────────────────

test('subprocess: missing env exits 1 and prints the real resolveApiConfig message', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, PRICE_ASSET: undefined, PRICE_PAYTO: undefined },
    encoding: 'utf8',
  });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /missing required env: PRICE_ASSET, PRICE_PAYTO/);
});

test('subprocess: a valid env exits 0', () => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: ROOT,
    env: { ...process.env, ...OK_ENV },
    encoding: 'utf8',
  });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /OK/);
});
