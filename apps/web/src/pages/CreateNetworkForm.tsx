/**
 * Network creation form (T-2.5/B). Validation happens server-side (single
 * source of truth); this form only shapes the request and renders the
 * API's structured errors. Custom topologies use the same node editor the
 * engine validates — nothing is accepted here that the API would reject
 * silently.
 */

import { useState } from 'react';
import type { FormEvent, JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { ApiError } from '../api/client';
import type { CreateNetworkInput, NetworkPreset } from '../api/types';

const PRESETS: Array<{ value: NetworkPreset; label: string; hint: string }> = [
  { value: 'single-node', label: 'Single node', hint: '1 validator — lightest option' },
  { value: 'two-node', label: 'Two nodes', hint: 'alice + bob, stock chain spec' },
  { value: 'four-validator', label: 'Four validators', hint: 'patched 4-authority genesis, full mesh' },
  { value: 'validator-fullnode', label: 'Validator + full node', hint: '3 validators + 1 keyless follower' },
  { value: 'custom', label: 'Custom', hint: 'define nodes yourself (max 6 validators)' },
];

const WELL_KNOWN_KEYS = ['alice', 'bob', 'charlie', 'dave', 'eve', 'ferdie'] as const;

interface CustomRow {
  name: string;
  role: 'validator' | 'full';
  wellKnownKey: string;
}

function defaultRows(): CustomRow[] {
  return [
    { name: 'alice', role: 'validator', wellKnownKey: 'alice' },
    { name: 'bob', role: 'validator', wellKnownKey: 'bob' },
  ];
}

export function CreateNetworkForm({ onCreated }: { onCreated?: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [preset, setPreset] = useState<NetworkPreset>('two-node');
  const [rows, setRows] = useState<CustomRow[]>(defaultRows);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [createdName, setCreatedName] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<CustomRow>): void =>
    setRows((rs) => rs.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setCreatedName(null);
    const input: CreateNetworkInput = {
      name: name.trim(),
      preset,
      ...(preset === 'custom'
        ? {
            custom: {
              nodes: rows.map((r) => ({
                name: r.name.trim(),
                role: r.role,
                ...(r.role === 'validator' ? { wellKnownKey: r.wellKnownKey } : {}),
              })),
            },
          }
        : {}),
    };
    try {
      const res = await apiClient.createNetwork(input);
      setCreatedName(input.name);
      onCreated?.();
      navigate(`/networks/${res.network.id}`);
    } catch (e2) {
      setError(e2 instanceof ApiError ? e2 : new ApiError(String(e2), 'INTERNAL', 0));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="panel form" onSubmit={(e) => void submit(e)} aria-label="Create network">
      <div className="panel-head">
        <h2>Create network</h2>
      </div>

      <div className="field">
        <label htmlFor="net-name">Name</label>
        <input
          id="net-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. demo-net"
          pattern="[a-z0-9][a-z0-9_-]{0,31}"
          title="lowercase letters, digits, - and _ (max 32)"
          aria-describedby="net-name-hint"
          required
        />
        <span id="net-name-hint" className="hint">
          lowercase letters, digits, “-”, “_” — max 32 chars
        </span>
      </div>

      <div className="field">
        <label htmlFor="net-preset">Topology</label>
        <select
          id="net-preset"
          value={preset}
          onChange={(e) => setPreset(e.target.value as NetworkPreset)}
        >
          {PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label} — {p.hint}
            </option>
          ))}
        </select>
      </div>

      {preset === 'custom' ? (
        <fieldset className="custom-nodes">
          <legend>Nodes ({rows.length}/8)</legend>
          {rows.map((r, i) => (
            <div className="custom-row" key={i}>
              <input
                aria-label={`Node ${i + 1} name`}
                value={r.name}
                onChange={(e) => setRow(i, { name: e.target.value })}
                placeholder="name"
                required
              />
              <select
                aria-label={`Node ${i + 1} role`}
                value={r.role}
                onChange={(e) =>
                  setRow(i, { role: e.target.value as CustomRow['role'], wellKnownKey: 'alice' })
                }
              >
                <option value="validator">validator</option>
                <option value="full">full node</option>
              </select>
              {r.role === 'validator' ? (
                <select
                  aria-label={`Node ${i + 1} key`}
                  value={r.wellKnownKey}
                  onChange={(e) => setRow(i, { wellKnownKey: e.target.value })}
                >
                  {WELL_KNOWN_KEYS.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted small">no key (keyless)</span>
              )}
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setRows((rs) => rs.filter((_, idx) => idx !== i))}
                disabled={rows.length <= 1}
                aria-label={`Remove node ${i + 1}`}
              >
                Remove
              </button>
            </div>
          ))}
          <button
            type="button"
            className="btn"
            onClick={() =>
              setRows((rs) =>
                rs.length >= 8
                  ? rs
                  : [...rs, { name: `node-${rs.length + 1}`, role: 'full', wellKnownKey: 'alice' }],
              )
            }
            disabled={rows.length >= 8}
          >
            Add node
          </button>
          <p className="hint">
            Validators need a unique well-known key (alice…ferdie, max 6); full nodes take none.
            The server validates all of this before creating anything.
          </p>
        </fieldset>
      ) : null}

      {error ? (
        <div className="form-error" role="alert">
          <strong>
            {error.code} — {error.message}
          </strong>
          {error.issues.length > 0 ? (
            <ul className="issues">
              {error.issues.map((issue, i) => (
                <li key={i}>{issue}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {createdName ? (
        <p className="form-ok" role="status">
          Network “{createdName}” created.
        </p>
      ) : null}

      <button type="submit" className="btn btn-primary" disabled={busy || name.trim() === ''}>
        {busy ? 'Creating…' : 'Create network'}
      </button>
    </form>
  );
}
