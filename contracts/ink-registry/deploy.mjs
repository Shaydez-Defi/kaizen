#!/usr/bin/env node
/**
 * Deploy the ink! registry twin to Portaldot V3 (pallet-contracts), anchor one
 * Kaizen certificate and read it back. Spends testnet tPOT.
 *
 *   KAIZEN_V3_SIGNER_SURI=... node contracts/ink-registry/deploy.mjs \
 *     <kaizen_ink_registry.contract> <certificate.json> <score> [--address <ss58>]
 *
 * Needs `@polkadot/api-contract` (npm i --no-save @polkadot/api-contract) and a
 * built engine (npm run build -w @kaizen/engine). With --address it skips the
 * instantiate and only records + reads on an existing contract. The signer
 * secret is read from the environment and never printed.
 */
import fs from 'node:fs';
import { ApiPromise, WsProvider, Keyring } from '@polkadot/api';
import { ContractPromise, CodePromise } from '@polkadot/api-contract';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { recordInputFromCertificate } from '../../packages/engine/dist/index.js';

const [contractFile, certFile, scoreArg, ...rest] = process.argv.slice(2);
if (!contractFile || !certFile || scoreArg === undefined) {
  console.error('usage: deploy.mjs <file.contract> <certificate.json> <score> [--address <ss58>]');
  process.exit(2);
}
const existing = rest[0] === '--address' ? rest[1] : undefined;
const WS = process.env.KAIZEN_V3_SUBSTRATE_WS || 'wss://test-node-v3.portaldot.dev';
const suri = process.env.KAIZEN_V3_SIGNER_SURI;
if (!suri) {
  console.error('set KAIZEN_V3_SIGNER_SURI in your env');
  process.exit(2);
}

const hexBytes = (h) => Uint8Array.from(Buffer.from(h.replace(/^0x/, ''), 'hex'));
const out = { chain: null, deploy: null, record: null, read: null };

await cryptoWaitReady();
const api = await ApiPromise.create({ provider: new WsProvider(WS) });
out.chain = { name: (await api.rpc.system.chain()).toString(), genesis: api.genesisHash.toHex() };
const pair = new Keyring({ type: 'sr25519' }).addFromUri(suri);
const decimals = api.registry.chainDecimals[0];
const free = async () => (await api.query.system.account(pair.address)).data.free.toBigInt();
const fmt = (n) => `${Number(n) / 10 ** decimals} ${api.registry.chainTokens[0]}`;

const metadata = JSON.parse(fs.readFileSync(contractFile, 'utf8'));
const maxGas = api.consts.system.blockWeights.maxBlock;

function submit(tx) {
  return new Promise((resolve, reject) => {
    tx.signAndSend(pair, (res) => {
      if (res.dispatchError) {
        let msg = res.dispatchError.toString();
        if (res.dispatchError.isModule) {
          const d = api.registry.findMetaError(res.dispatchError.asModule);
          msg = `${d.section}.${d.name}`;
        }
        reject(new Error(msg));
      } else if (res.status.isFinalized) {
        const events = res.events.map((e) => `${e.event.section}.${e.event.method}`);
        resolve({ txHash: tx.hash.toHex(), blockHash: res.status.asFinalized.toHex(), events, raw: res });
      }
    }).catch(reject);
  });
}

async function blockNumber(blockHash) {
  return (await api.rpc.chain.getHeader(blockHash)).number.toNumber();
}

let address = existing;
if (!address) {
  const code = new CodePromise(api, metadata, metadata.source.wasm);
  const before = await free();
  const dry = await api.call.contractsApi.instantiate(
    pair.address,
    0,
    null,
    null,
    { Upload: metadata.source.wasm },
    code.abi.constructors[0].toU8a([]),
    new Uint8Array(0),
  );
  console.error('dry-run instantiate:', dry.result.isOk ? 'ok' : dry.result.toString(), 'gas', dry.gasRequired.toString(), 'deposit', dry.storageDeposit.toString());
  if (dry.result.isErr) throw new Error(`dry run failed: ${dry.result.toString()}`);
  if (process.env.KAIZEN_DRY_RUN) {
    console.log(JSON.stringify({ dryRun: true, gasRequired: dry.gasRequired.toHuman(), storageDeposit: dry.storageDeposit.toHuman(), balance: fmt(before) }, null, 2));
    await api.disconnect();
    process.exit(0);
  }
  const tx = api.tx.contracts.instantiateWithCode(
    0,
    dry.gasRequired,
    null,
    metadata.source.wasm,
    code.abi.constructors[0].toU8a([]),
    new Uint8Array(0),
  );
  const r = await submit(tx);
  const inst = r.raw.events.find((e) => e.event.section === 'contracts' && e.event.method === 'Instantiated');
  if (!inst) throw new Error(`no contracts.Instantiated event; events: ${r.events.join(',')}`);
  address = inst.event.data[1].toString();
  const after = await free();
  out.deploy = {
    address,
    codeHash: metadata.source.hash,
    txHash: r.txHash,
    blockHash: r.blockHash,
    blockNumber: await blockNumber(r.blockHash),
    events: r.events,
    spentPlanck: String(before - after),
    spent: fmt(before - after),
  };
  console.error('deployed', address, 'spent', out.deploy.spent);
}

const contract = new ContractPromise(api, metadata, address);
const cert = JSON.parse(fs.readFileSync(certFile, 'utf8'));
const i = recordInputFromCertificate(cert, Number(scoreArg));
const U32 = 0xffffffff;
const U16 = 0xffff;
const args = [
  hexBytes(i.validator),
  hexBytes(i.fingerprint),
  hexBytes(i.runHash),
  hexBytes(i.signer),
  i.timeToRecoverMs === null ? U32 : Math.min(i.timeToRecoverMs, U32 - 1),
  i.finalityGapBlocks === null ? U16 : Math.min(i.finalityGapBlocks, U16 - 1),
  i.blocksMissed === null ? U16 : Math.min(i.blocksMissed, U16 - 1),
  i.score,
  i.evidenceFlags & 0xff,
  hexBytes(i.signature),
];

const certBefore = await contract.query.certOf(pair.address, { gasLimit: maxGas }, hexBytes(i.fingerprint));
if (certBefore.output && !certBefore.output.isEmpty && certBefore.output.toJSON()?.ok) {
  console.error('already recorded; skipping record');
} else {
  const q = await contract.query.record(pair.address, { gasLimit: maxGas }, ...args);
  if (q.result.isErr || (q.output && q.output.toJSON()?.ok?.err)) {
    throw new Error(`record dry run failed: ${q.result.toString()} ${q.output?.toString()}`);
  }
  const before = await free();
  const r = await submit(contract.tx.record({ gasLimit: q.gasRequired }, ...args));
  const emitted = r.raw.events.filter((e) => e.event.section === 'contracts' && e.event.method === 'ContractEmitted').length;
  const after = await free();
  out.record = {
    txHash: r.txHash,
    blockHash: r.blockHash,
    blockNumber: await blockNumber(r.blockHash),
    events: r.events,
    contractEmittedEvents: emitted,
    spentPlanck: String(before - after),
    spent: fmt(before - after),
  };
  console.error('recorded in block', out.record.blockNumber, 'spent', out.record.spent);
}

const s = await contract.query.getScore(pair.address, { gasLimit: maxGas }, hexBytes(i.validator));
const c = await contract.query.certOf(pair.address, { gasLimit: maxGas }, hexBytes(i.fingerprint));
out.read = { contract: address, getScore: s.output?.toJSON(), certOf: c.output?.toJSON(), bestBlock: (await api.rpc.chain.getHeader()).number.toNumber() };
console.log(JSON.stringify(out, null, 2));
await api.disconnect();
