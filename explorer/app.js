// Kaizen Explorer: static, dependency-free. Reads the committed index (data/index.json)
// and verifies every claim against Portaldot V3 with plain JSON-RPC fetches (CORS is open).
const SEL = { certOf: '0xf0347798', getScore: '0x7ba53285' }; // keccak4 of certOf(bytes32) / getScore(bytes32)
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const w32 = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const words = (d, n) => Array.from({ length: n }, (_, i) => Number(BigInt('0x' + d.replace(/^0x/, '').slice(i * 64, (i + 1) * 64))));

async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const ethCall = (idx, to, data) => rpc(idx.evmRpc, 'eth_call', [{ to, data }, 'latest']);

export async function readCert(idx, address, fingerprint) {
  const d = await ethCall(idx, address, SEL.certOf + w32(fingerprint));
  const [score, block] = words(d, 2);
  return { score, block, recorded: block > 0 };
}
export async function readScore(idx, address, validatorKey) {
  const d = await ethCall(idx, address, SEL.getScore + w32(validatorKey));
  const [score, block, count] = words(d, 3);
  return { score, block, count };
}

async function main() {
  const idx = await (await fetch('data/index.json')).json();
  try {
    const gen = await rpc(idx.substrateRpc, 'chain_getBlockHash', [0]);
    const head = await rpc(idx.substrateRpc, 'chain_getHeader');
    const same = gen === idx.genesisHash;
    $('net').innerHTML = `${esc(idx.network)} · head #${parseInt(head.number, 16)} · genesis ${same ? '<span class="ok">matches</span>' : '<span class="bad">DIFFERS from index</span>'}`;
  } catch (e) { $('net').innerHTML = `<span class="bad">V3 unreachable: ${esc(e.message)}</span>`; }

  $('surfaces').innerHTML = '<table><tr><th>Surface</th><th>Address</th><th>Status</th></tr>' +
    idx.surfaces.map((s) => `<tr><td>${esc(s.label)}</td><td><code>${esc(s.address || 'n/a')}</code></td><td>${esc(s.status)}</td></tr>`).join('') + '</table>';

  const live = idx.surfaces.filter((s) => s.address);
  const rows = [];
  for (const c of idx.certificates) {
    const s = live.find((x) => x.id === c.surface);
    let r = { score: '…', count: '…' };
    try { r = await readScore(idx, s.address, c.validatorKey); } catch (e) { r = { score: 'n/a', count: 'n/a' }; }
    rows.push({ c, r });
  }
  rows.sort((a, b) => (b.r.score || 0) - (a.r.score || 0));
  $('board').innerHTML = '<table><tr><th>#</th><th>Validator</th><th>On-chain score</th><th>Certificates</th></tr>' +
    rows.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.c.validatorId)}<br><code>${esc(x.c.validatorKey)}</code></td><td>${esc(x.r.score)}</td><td>${esc(x.r.count)}</td></tr>`).join('') + '</table>';

  $('certs').innerHTML = '<table><tr><th>Certificate</th><th>Indexed</th><th>Verify against chain</th></tr>' +
    idx.certificates.map((c, i) => `<tr><td><code>${esc(c.fingerprint)}</code><br><span class="mute">${esc(c.source)}</span></td>
    <td>score ${c.score}, anchored block ${c.anchorBlock}<br>recover ${c.timeToRecoverMs} ms, finality gap ${c.finalityGapBlocks}, missed ${c.blocksMissed}${c.devKey ? '<br>dev key' : ''}</td>
    <td><button data-i="${i}">Verify</button><div id="v${i}" class="mute"></div></td></tr>`).join('') + '</table>';
  document.querySelectorAll('button[data-i]').forEach((b) => b.addEventListener('click', async () => {
    const i = Number(b.dataset.i), c = idx.certificates[i], out = $('v' + i);
    const s = live.find((x) => x.id === c.surface);
    out.textContent = 'reading chain…';
    try {
      const r = await readCert(idx, s.address, c.fingerprint);
      const ok = r.recorded && r.score === c.score && r.block === c.anchorBlock;
      out.innerHTML = ok ? `<span class="ok">verified</span>: registry certOf returns score ${r.score} at block ${r.block}, matching the index`
        : `<span class="bad">mismatch</span>: chain says score ${r.score}, block ${r.block}${r.recorded ? '' : ' (not recorded)'}`;
    } catch (e) { out.innerHTML = `<span class="bad">could not verify</span>: ${esc(e.message)}`; }
  }));
}
if (typeof document !== 'undefined') main();
