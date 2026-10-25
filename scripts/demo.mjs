#!/usr/bin/env node
// One-command demo: verifies every certificate in explorer/data/index.json against the
// Portaldot V3 registry (read-only eth_call, no node, no keys, no dependencies; Node >= 18).
import { readFile } from 'node:fs/promises';
const SEL = { certOf: '0xf0347798', getScore: '0x7ba53285' };
const w32 = (h) => h.replace(/^0x/, '').padStart(64, '0');
const words = (d, n) => Array.from({ length: n }, (_, i) => Number(BigInt('0x' + d.slice(2).slice(i * 64, (i + 1) * 64))));
const idx = JSON.parse(await readFile(new URL('../explorer/data/index.json', import.meta.url), 'utf8'));
async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const call = (to, data) => rpc(idx.evmRpc, 'eth_call', [{ to, data }, 'latest']);
let failed = 0;
const gen = await rpc(idx.substrateRpc, 'chain_getBlockHash', [0]);
const genOk = gen === idx.genesisHash;
console.log(`Kaizen demo: ${idx.network}\n  genesis ${genOk ? 'matches' : 'MISMATCH'} (${gen.slice(0, 12)}...)`);
if (!genOk) failed++;
for (const c of idx.certificates ?? []) {
  const s = idx.surfaces.find((x) => x.id === c.surface);
  if (!s?.address) { console.log(`  skip ${c.fingerprint.slice(0, 12)}: surface ${c.surface} not deployed`); continue; }
  const [score, block] = words(await call(s.address, SEL.certOf + w32(c.fingerprint)), 2);
  const [latest, , count] = words(await call(s.address, SEL.getScore + w32(c.validatorKey)), 3);
  const ok = block > 0 && (c.score === undefined || c.score === score);
  if (!ok) failed++;
  console.log(`  ${ok ? 'VERIFIED' : 'FAILED  '} cert ${c.fingerprint.slice(0, 12)}... on ${s.label}: score ${score} at block ${block}; validator ${c.validatorId} latest ${latest} (${count} certs)`);
}
console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed against live V3.');
process.exit(failed ? 1 : 0);
