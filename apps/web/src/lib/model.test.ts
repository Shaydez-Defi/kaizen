/** View-model derivation (T-3.6B): no invented values, honest link basis. */

import { describe, expect, it } from 'vitest';
import { blockUrl, buildVNet, formatTokens, isValidNetworkName, peerIdsFromBootnodes, slugifyNetworkName } from './model';
import { makeHealth, makeNetwork, makeNode, makeSample, makeSnapshot } from '../test-utils/fixtures';

const alice = makeNode({ status: 'running', bootnodes: ['/ip4/127.0.0.1/tcp/30334/p2p/12D3KooWBzBzB'] });
const bob = makeNode({ id: 'net_1-bob', name: 'demo-bob', status: 'running', ports: { p2p: 30334, rpc: 1, ws: 2, prometheus: 3 }, bootnodes: ['/ip4/127.0.0.1/tcp/30333/p2p/12D3KooWAzAzA'] });

describe('buildVNet', () => {
  it('marks links observed via system_peers ids and keeps unknowns null', () => {
    const snap = makeSnapshot({
      samples: [makeSample({ peers: { count: 1, expected: 1, list: [{ peerId: '12D3KooWBzBzB', roles: 'AUTHORITY', bestHash: '0x', bestNumber: 1 }] } }), makeSample({ nodeId: 'net_1-bob', head: null, finalized: null })],
      health: [makeHealth(), makeHealth({ nodeId: 'net_1-bob' })],
    });
    const v = buildVNet(makeNetwork(), [alice, bob], snap);
    expect(v.nodes.map((n) => n.peerId)).toEqual(['12D3KooWAzAzA', '12D3KooWBzBzB']);
    expect(v.edges[0]).toMatchObject({ basis: 'observed', alive: true });
    expect(v.nodes[1]!.height).toBeNull();
  });

  it('marks links down when an endpoint is unreachable, and paused under a pause fault', () => {
    const snap = makeSnapshot({ samples: [makeSample(), makeSample({ nodeId: 'net_1-bob', rpc: { reachable: false } })], health: [makeHealth(), makeHealth({ nodeId: 'net_1-bob', state: 'unavailable' })] });
    const fault = { id: 'f', nodeId: 'net_1-alice', type: 'pause', mode: 'execute', state: 'executing' } as never;
    const v = buildVNet(makeNetwork(), [alice, bob], snap, [fault]);
    expect(v.edges[0]!.basis).toBe('down');
    expect(v.nodes[0]!.state).toBe('paused');
    expect(v.nodes[1]!.stateLabel).toBe('Unreachable');
  });

  it('without a snapshot nothing is invented', () => {
    const v = buildVNet(makeNetwork(), [makeNode()], null);
    expect(v.nodes[0]).toMatchObject({ height: null, peers: null, stateLabel: 'Not started' });
  });
});

describe('helpers', () => {
  it('slugifies and validates network names like the API', () => {
    expect(slugifyNetworkName('  My Net!! ')).toBe('my-net');
    expect(isValidNetworkName('my-net')).toBe(true);
    expect(isValidNetworkName('-bad')).toBe(false);
  });
  it('builds node-console block links only from a real template + hash', () => {
    const t = 'https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/{block}';
    expect(blockUrl(t, '0xabc')).toBe('https://node-console.portaldot.dev/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/0xabc');
    expect(blockUrl(t, null)).toBeNull();
    expect(blockUrl('no-placeholder', '0xabc')).toBeNull();
  });
  it('formats planck balances without float rounding', () => {
    expect(formatTokens('315000000000000', 14, 'tPOT')).toBe('3.1500 tPOT');
    expect(formatTokens(null, 14)).toBe('—');
  });
  it('maps bootnode multiaddrs to peer ids by port', () => {
    expect(peerIdsFromBootnodes([alice]).get(30334)).toBe('12D3KooWBzBzB');
  });
});
