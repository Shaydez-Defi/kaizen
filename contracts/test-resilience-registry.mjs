#!/usr/bin/env node
/**
 * Execution test for KaizenResilienceRegistry (T-9.4): deploys the
 * COMMITTED artifact bytecode into an in-memory EVM and exercises record /
 * getScore / getLatest / reverts / events. Like solc, the EVM is optional
 * tooling, not a repo dependency:
 *
 *   npm i --no-save @ethereumjs/evm@10 @ethereumjs/util@10
 *   node contracts/test-resilience-registry.mjs
 *
 * pallet-revive runs the same EVM bytecode (allowEVMBytecode, R-30); this
 * checks contract logic, not revive gas/deposit costs (RSK-30).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let createEVM, createAddressFromString, hexToBytes, bytesToHex, keccak256;
try {
  ({ createEVM } = await import('@ethereumjs/evm'));
  ({ createAddressFromString, hexToBytes, bytesToHex } = await import('@ethereumjs/util'));
  ({ keccak_256: keccak256 } = await import('@noble/hashes/sha3.js'));
} catch {
  console.error('Run: npm i --no-save @ethereumjs/evm@10 @ethereumjs/util@10');
  process.exit(1);
}
const art = JSON.parse(fs.readFileSync(path.join(here, 'KaizenResilienceRegistry.artifact.json'), 'utf8'));
const sel = (sig) => art.methodIdentifiers[sig];
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const b32 = (byte) => byte.repeat(32);
const caller = createAddressFromString('0x' + '11'.repeat(20));

const evm = await createEVM();
let passed = 0;
const it = async (name, fn) => {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
};

const deploy = await evm.runCall({ data: hexToBytes(art.bytecode), gasLimit: 10_000_000n, caller });
assert.equal(deploy.execResult.exceptionError, undefined, 'deploy failed');
const to = deploy.createdAddress;

async function call(data, ts = 1_700_000_000n) {
  const r = await evm.runCall({ to, caller, data: hexToBytes('0x' + data), gasLimit: 5_000_000n, block: { header: { timestamp: ts, number: 1n, coinbase: caller, gasLimit: 30_000_000n, baseFeePerGas: 0n, difficulty: 0n, prevRandao: new Uint8Array(32), getBlobGasPrice: () => 0n } } });
  return r.execResult;
}
const recordData = ({ validator = b32('01'), fp = b32('02'), score = 67, ttr = 12000, gap = 6, missed = 6, flags = 1, sig = 'ab'.repeat(64), signer = b32('04') } = {}) =>
  sel('record(bytes32,bytes32,bytes32,bytes32,uint32,uint16,uint16,uint8,uint8,bytes)') +
  validator + fp + b32('03') + signer + word(ttr) + word(gap) + word(missed) + word(score) + word(flags) + word(320) + word(sig.length / 2) + sig.padEnd(Math.ceil(sig.length / 64) * 64, '0');
const revertReason = (res) => {
  const out = bytesToHex(res.returnValue).slice(2);
  if (!out.startsWith('08c379a0')) return null;
  const len = Number(BigInt('0x' + out.slice(8 + 64, 8 + 128)));
  return Buffer.from(out.slice(8 + 128, 8 + 128 + len * 2), 'hex').toString();
};
const hex = (res) => bytesToHex(res.returnValue).slice(2);

console.log('KaizenResilienceRegistry (in-memory EVM)');
await it('getScore is (0,0,0) and recorded is false before any certificate', async () => {
  assert.equal(hex(await call(sel('getScore(bytes32)') + b32('01'))), word(0) + word(0) + word(0));
  assert.equal(hex(await call(sel('recorded(bytes32)') + b32('02'))), word(0));
});
await it('record emits CertificateRecorded with the full detail', async () => {
  const res = await call(recordData(), 1_700_000_123n);
  assert.equal(res.exceptionError, undefined, revertReason(res) ?? 'reverted');
  assert.equal(res.logs.length, 1);
  const [, topics] = res.logs[0];
  const topic0 = bytesToHex(keccak256(new TextEncoder().encode('CertificateRecorded(bytes32,bytes32,bytes32,bytes32,uint8,uint8,uint32,uint16,uint16,uint64,bytes)')));
  assert.equal(bytesToHex(topics[0]), topic0);
  assert.equal(bytesToHex(topics[1]).slice(2), b32('01'));
  assert.equal(bytesToHex(topics[2]).slice(2), b32('02'));
  assert.equal(bytesToHex(topics[3]).slice(2), b32('04'));
});
await it('getScore / certOf / recorded reflect it (score, block, count)', async () => {
  assert.equal(hex(await call(sel('getScore(bytes32)') + b32('01'))), word(67) + word(1) + word(1));
  assert.equal(hex(await call(sel('certOf(bytes32)') + b32('02'))), word(67) + word(1));
  assert.equal(hex(await call(sel('recorded(bytes32)') + b32('02'))), word(1));
});
await it('a fingerprint is recorded only once (idempotent anchoring)', async () => {
  assert.equal(revertReason(await call(recordData())), 'already recorded');
});
await it('latest wins: a second certificate updates getScore', async () => {
  assert.equal((await call(recordData({ fp: b32('05'), score: 80 }), 1_700_000_200n)).exceptionError, undefined);
  assert.equal(hex(await call(sel('getScore(bytes32)') + b32('01'))), word(80) + word(1) + word(2));
});
await it('rejects invalid input', async () => {
  assert.equal(revertReason(await call(recordData({ fp: b32('06'), score: 101 }))), 'score > 100');
  assert.equal(revertReason(await call(recordData({ fp: b32('07'), sig: 'ab'.repeat(65) }))), 'bad signature length');
  assert.equal(revertReason(await call(recordData({ fp: b32('00') }))), 'zero fingerprint');
  assert.equal(revertReason(await call(recordData({ fp: b32('08'), validator: b32('00') }))), 'zero validator');
  assert.equal(revertReason(await call(recordData({ fp: b32('09'), signer: b32('00') }))), 'zero signer');
});
console.log(`${passed} passed`);
