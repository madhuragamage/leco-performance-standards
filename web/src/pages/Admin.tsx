import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { unitLong } from '../format';
import type { ReasonCode } from '../types';

type Tab = 'targets' | 'approvals' | 'penalties' | 'supply' | 'reasons' | 'holidays' | 'cscs' | 'users';

interface Threshold {
  id: number;
  clockKey: string;
  natureOfSupply: string;
  changesRequired: string;
  feederClass: number;
  internalTarget: number | null;
  regulatoryTarget: number | null;
  provisional: boolean;
  note: string | null;
}

function useClocks() {
  const { meta } = useApp();
  return meta.services.flatMap((s) => s.clocks.map((c) => ({ ...c, serviceName: s.name, natureOptions: s.natureOptions })));
}

const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

function Targets({ canEdit }: { canEdit: boolean }) {
  const { meta } = useApp();
  const clocks = useClocks();
  const [rows, setRows] = useState<Threshold[]>([]);
  const [clockKey, setClockKey] = useState(clocks[0].key);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [add, setAdd] = useState({ natureOfSupply: '*', changesRequired: 'ANY', feederClass: 0, internalTarget: '', regulatoryTarget: '', provisional: true, note: '' });
  const load = useCallback(() => api<Threshold[]>('/admin/thresholds').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  const clock = clocks.find((c) => c.key === clockKey)!;
  const list = rows.filter((r) => r.clockKey === clockKey);

  async function save(r: Threshold, patch: Partial<Threshold>) {
    try {
      setError(null);
      await api(`/admin/thresholds/${r.id}`, { method: 'PUT', body: patch });
      setMsg('Saved. New targets apply to running measures immediately; use "Re-evaluate" to apply them to closed ones.');
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api('/admin/thresholds', {
        method: 'POST',
        body: { clockKey, natureOfSupply: add.natureOfSupply, changesRequired: add.changesRequired, feederClass: Number(add.feederClass), internalTarget: numOrNull(add.internalTarget), regulatoryTarget: numOrNull(add.regulatoryTarget), provisional: add.provisional, note: add.note || null },
      });
      setAdd({ ...add, internalTarget: '', regulatoryTarget: '', note: '' });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function recompute() {
    if (!confirm('Re-evaluate all closed measures against the current targets? Compliance and compensation figures in reports will change.')) return;
    try {
      const r = await api<{ recomputed: number }>('/admin/recompute', { method: 'POST', body: {} });
      setMsg(`Re-evaluated ${r.recomputed} requests.`);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <p className="muted">
        Two-stage thresholds (report section 1.5.5): <b>LECO internal</b> = Threshold 11 (no changes) / 12 (with changes); <b>regulatory</b> = Threshold 21 / 22. The most specific matching row applies
        (nature of supply, then changes required, then feeder class). Rows marked provisional are awaiting PUCSL base-level targets.
      </p>
      <div className="filters bar">
        <select value={clockKey} onChange={(e) => setClockKey(e.target.value)}>
          {clocks.map((c) => <option key={c.key} value={c.key}>{c.serviceName} - {c.label}</option>)}
        </select>
        <span className="muted small">{clock.measure} ({unitLong[clock.unit]}{clock.mode === 'MIN_LEAD' ? ', minimum' : ''})</span>
        {canEdit && <button className="btn" onClick={recompute}>Re-evaluate closed measures</button>}
      </div>
      <ErrorBox error={error} />
      {msg && <div className="ok-box">{msg}</div>}
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Nature of supply</th><th>Changes required</th><th>Feeder class</th><th>LECO target</th><th>Regulatory target</th><th>Provisional</th><th>Note</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {list.length === 0 && <tr><td colSpan={8} className="muted">No targets defined - measures show "No target set".</td></tr>}
              {list.map((r) => (
                <tr key={r.id}>
                  <td>{r.natureOfSupply === '*' ? 'Any' : meta.natureLabels[r.natureOfSupply]}</td>
                  <td>{r.changesRequired === 'ANY' ? 'Any' : r.changesRequired === 'YES' ? 'Yes' : 'No'}</td>
                  <td>{r.feederClass === 0 ? 'Any' : `FC${r.feederClass}`}</td>
                  <td>{canEdit ? <input className="num-input" type="number" step="any" min={0} defaultValue={r.internalTarget ?? ''} onBlur={(e) => numOrNull(e.target.value) !== r.internalTarget && save(r, { internalTarget: numOrNull(e.target.value) })} /> : r.internalTarget ?? '-'}</td>
                  <td>{canEdit ? <input className="num-input" type="number" step="any" min={0} defaultValue={r.regulatoryTarget ?? ''} onBlur={(e) => numOrNull(e.target.value) !== r.regulatoryTarget && save(r, { regulatoryTarget: numOrNull(e.target.value) })} /> : r.regulatoryTarget ?? '-'}</td>
                  <td>{canEdit ? <input type="checkbox" checked={r.provisional} onChange={(e) => save(r, { provisional: e.target.checked })} /> : r.provisional ? 'Yes' : 'No'}</td>
                  <td className="small muted">{r.note}</td>
                  {canEdit && (
                    <td>
                      <button className="link danger-link" onClick={async () => { if (confirm('Delete this target row?')) { await api(`/admin/thresholds/${r.id}`, { method: 'DELETE' }); await load(); } }}>
                        Delete
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {canEdit && (
        <form className="card form-row" onSubmit={create}>
          <h2>Add / replace target row</h2>
          <label>Nature<select value={add.natureOfSupply} onChange={(e) => setAdd({ ...add, natureOfSupply: e.target.value })}><option value="*">Any</option>{clock.natureOptions.map((n) => <option key={n} value={n}>{meta.natureLabels[n]}</option>)}</select></label>
          <label>Changes<select value={add.changesRequired} onChange={(e) => setAdd({ ...add, changesRequired: e.target.value })}><option value="ANY">Any</option><option value="NO">No (Threshold x1)</option><option value="YES">Yes (Threshold x2)</option></select></label>
          <label>Feeder class<select value={add.feederClass} onChange={(e) => setAdd({ ...add, feederClass: Number(e.target.value) })}><option value={0}>Any</option>{[1, 2, 3, 4].map((f) => <option key={f} value={f}>FC{f}</option>)}</select></label>
          <label>LECO target<input type="number" step="any" min={0} value={add.internalTarget} onChange={(e) => setAdd({ ...add, internalTarget: e.target.value })} /></label>
          <label>Regulatory target<input type="number" step="any" min={0} value={add.regulatoryTarget} onChange={(e) => setAdd({ ...add, regulatoryTarget: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={add.provisional} onChange={(e) => setAdd({ ...add, provisional: e.target.checked })} /> Provisional</label>
          <label>Note<input value={add.note} onChange={(e) => setAdd({ ...add, note: e.target.value })} /></label>
          <button className="btn primary">Save row</button>
        </form>
      )}
    </>
  );
}

const APPROVERS = ['CSS', 'BM', 'SDM', 'HENG', 'GM'];

function ApprovalLimits({ canEdit }: { canEdit: boolean }) {
  const { meta, reloadMeta } = useApp();
  const [rows, setRows] = useState<{ role: string; upTo: number | null; updatedAt: string | null }[]>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api<typeof rows>('/admin/approval-limits')
        .then((r) => {
          setRows(r);
          setEdit(Object.fromEntries(r.map((x) => [x.role, x.upTo === null ? '' : String(x.upTo)])));
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => void load(), [load]);
  const label = (r: string) => meta.roles.find((x) => x.code === r)?.label ?? r;
  const fmt = (n: number) => `LKR ${n.toLocaleString('en-US')}`;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      await api('/admin/approval-limits', {
        method: 'PUT',
        body: APPROVERS.map((role) => ({ role, upTo: role === 'GM' ? null : edit[role]?.trim() ? Number(edit[role]) : NaN })),
      });
      await load();
      await reloadMeta();
      setMsg('Approval limits saved. They apply to the next estimate approval.');
    } catch (err) {
      setError((err as Error).message);
    }
  }

  // Preview the bands from the values being edited.
  let lower = 0;
  const bands = APPROVERS.map((role) => {
    const top = role === 'GM' ? null : Number(edit[role]);
    const text = top === null ? `over ${fmt(lower)}` : `${lower ? `over ${fmt(lower)} up to` : 'up to'} ${Number.isFinite(top) ? fmt(top) : '?'}`;
    if (top !== null && Number.isFinite(top)) lower = top;
    return { role, text };
  });

  return (
    <>
      <p className="muted">
        Estimate approval authority (report section 2.1). Each level may approve estimates up to its limit; a higher level may always approve a lower amount. The General Manager has no upper limit so every estimate has an approver.
      </p>
      <ErrorBox error={error} />
      {msg && <div className="ok-box">{msg}</div>}
      <form className="card" onSubmit={save}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Approver</th><th>May approve estimates up to (LKR)</th><th>Band (lowest authority that must approve)</th><th>Last changed</th></tr></thead>
            <tbody>
              {APPROVERS.map((role, i) => (
                <tr key={role}>
                  <td>{label(role)}</td>
                  <td>
                    {role === 'GM' ? (
                      <span className="muted">No limit</span>
                    ) : canEdit ? (
                      <input className="num-input wide" type="number" min={1} step={1000} required value={edit[role] ?? ''} onChange={(e) => setEdit({ ...edit, [role]: e.target.value })} aria-label={`${label(role)} limit`} />
                    ) : (
                      fmt(rows.find((r) => r.role === role)?.upTo ?? 0)
                    )}
                  </td>
                  <td>{bands[i].text}</td>
                  <td className="small muted">{rows.find((r) => r.role === role)?.updatedAt ? new Date(rows.find((r) => r.role === role)!.updatedAt!).toLocaleString('en-GB') : 'Default (report)'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && (
          <div className="form-actions">
            <button type="button" className="btn" onClick={load}>Reset</button>
            <button className="btn primary">Save limits</button>
          </div>
        )}
      </form>
    </>
  );
}

interface SupplyTarget { feederClass: number; saidi: number | null; saifi: number | null; maifi: number | null; individualHours: number | null; provisional: boolean; note: string | null }

function SupplyTargets({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<SupplyTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => api<{ targets: SupplyTarget[] }>('/supply/meta').then((m) => setRows(m.targets)).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  const set = (fc: number, patch: Partial<SupplyTarget>) => setRows(rows.map((r) => (r.feederClass === fc ? { ...r, ...patch } : r)));
  const num = (v: string) => (v.trim() === '' ? null : Number(v));
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api('/supply/targets', { method: 'PUT', body: rows.map(({ feederClass, saidi, saifi, maifi, individualHours, provisional, note }) => ({ feederClass, saidi, saifi, maifi, individualHours, provisional, note })) });
      setMsg('Saved.');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <>
      <p className="muted">
        Approved overall supply quality levels per feeder class (report section 12.1, "to be set by PUCSL"), compared with LECO SAIDI / SAIFI on the Supply quality page, and the specified annual interruption duration per transformer (section 12.3).
      </p>
      <ErrorBox error={error} />
      {msg && <div className="ok-box">{msg}</div>}
      <form className="card" onSubmit={save}>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Feeder class</th><th>Approved SAIDI (h/yr)</th><th>Approved SAIFI (/yr)</th><th>MAIFI (/yr)</th><th>Individual duration (h/yr)</th><th>Provisional</th><th>Note</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.feederClass}>
                  <td>FC{r.feederClass}</td>
                  {(['saidi', 'saifi', 'maifi', 'individualHours'] as const).map((k) => (
                    <td key={k}>{canEdit ? <input className="num-input" type="number" step="any" min={0} value={r[k] ?? ''} onChange={(e) => set(r.feederClass, { [k]: num(e.target.value) })} aria-label={`FC${r.feederClass} ${k}`} /> : r[k] ?? '-'}</td>
                  ))}
                  <td>{canEdit ? <input type="checkbox" checked={r.provisional} onChange={(e) => set(r.feederClass, { provisional: e.target.checked })} /> : r.provisional ? 'Yes' : 'No'}</td>
                  <td className="small muted">{r.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {canEdit && <div className="form-actions"><button className="btn primary">Save</button></div>}
      </form>
    </>
  );
}

interface Penalty { id: number; clockKey: string; natureOfSupply: string; ratePerUnit: number; maxAmount: number; perAffectedCustomer: boolean; note: string | null }

function Penalties({ canEdit }: { canEdit: boolean }) {
  const { meta } = useApp();
  const clocks = useClocks();
  const [rows, setRows] = useState<Penalty[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ clockKey: clocks[0].key, natureOfSupply: '*', ratePerUnit: '', maxAmount: '', perAffectedCustomer: false, note: '' });
  const load = useCallback(() => api<Penalty[]>('/admin/penalties').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  const label = (k: string) => clocks.find((c) => c.key === k)?.label ?? k;
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      await api('/admin/penalties', { method: 'POST', body: { ...f, ratePerUnit: Number(f.ratePerUnit), maxAmount: Number(f.maxAmount), note: f.note || null } });
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <>
      <p className="muted">Compensation to the customer (report section 1.3): rate per day (or hour) of default beyond the regulatory target, capped at the maximum. Applies only when a regulatory target is set.</p>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Measure</th><th>Nature</th><th className="num">Rate (LKR)</th><th className="num">Maximum (LKR)</th><th>Per affected customer</th><th>Note</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{label(r.clockKey)}</td>
                  <td>{r.natureOfSupply === '*' ? 'Any' : meta.natureLabels[r.natureOfSupply]}</td>
                  <td className="num">{r.ratePerUnit}</td>
                  <td className="num">{r.maxAmount}</td>
                  <td>{r.perAffectedCustomer ? 'Yes' : 'No'}</td>
                  <td className="small muted">{r.note}</td>
                  {canEdit && <td><button className="link danger-link" onClick={async () => { if (confirm('Delete rule?')) { await api(`/admin/penalties/${r.id}`, { method: 'DELETE' }); await load(); } }}>Delete</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {canEdit && (
        <form className="card form-row" onSubmit={save}>
          <h2>Add / replace rule</h2>
          <label>Measure<select value={f.clockKey} onChange={(e) => setF({ ...f, clockKey: e.target.value })}>{clocks.map((c) => <option key={c.key} value={c.key}>{c.serviceName} - {c.label}</option>)}</select></label>
          <label>Nature<select value={f.natureOfSupply} onChange={(e) => setF({ ...f, natureOfSupply: e.target.value })}><option value="*">Any</option>{Object.entries(meta.natureLabels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label>Rate<input type="number" min={0} required value={f.ratePerUnit} onChange={(e) => setF({ ...f, ratePerUnit: e.target.value })} /></label>
          <label>Maximum<input type="number" min={0} required value={f.maxAmount} onChange={(e) => setF({ ...f, maxAmount: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={f.perAffectedCustomer} onChange={(e) => setF({ ...f, perAffectedCustomer: e.target.checked })} /> Per affected customer</label>
          <label>Note<input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          <button className="btn primary">Save rule</button>
        </form>
      )}
    </>
  );
}

function Reasons({ canEdit }: { canEdit: boolean }) {
  const { reloadMeta } = useApp();
  const [rows, setRows] = useState<ReasonCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ category: 'DELAY', code: '', description: '' });
  const load = useCallback(() => api<ReasonCode[]>('/admin/reason-codes').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  async function upsert(body: Partial<ReasonCode>) {
    try {
      await api('/admin/reason-codes', { method: 'POST', body });
      await load();
      await reloadMeta();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Category</th><th>Code</th><th>Description</th><th>Active</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.category.replace('_', ' ').toLowerCase()}</td>
                  <td className="mono">{r.code}</td>
                  <td>{r.description}</td>
                  <td>{canEdit ? <input type="checkbox" checked={r.active} onChange={(e) => upsert({ category: r.category, code: r.code, description: r.description, active: e.target.checked })} /> : r.active ? 'Yes' : 'No'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {canEdit && (
        <form className="card form-row" onSubmit={(e) => { e.preventDefault(); void upsert({ ...f, active: true }); setF({ ...f, code: '', description: '' }); }}>
          <h2>Add reason code</h2>
          <label>Category<select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['NON_CONFORMITY', 'WAYLEAVE', 'OBJECTION', 'DELAY'].map((c) => <option key={c} value={c}>{c.replace('_', ' ').toLowerCase()}</option>)}</select></label>
          <label>Code<input required maxLength={20} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          <label className="grow">Description<input required value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
          <button className="btn primary">Add</button>
        </form>
      )}
    </>
  );
}

function Holidays({ canEdit }: { canEdit: boolean }) {
  const [rows, setRows] = useState<{ date: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ date: '', name: '' });
  const load = useCallback(() => api<{ date: string; name: string }[]>('/admin/holidays').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  return (
    <>
      <p className="muted">Working-day measures skip weekends and these holidays. Load Poya and other variable public/bank holidays from the government gazette each year.</p>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Date</th><th>Holiday</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {rows.map((h) => (
                <tr key={h.date}>
                  <td className="mono">{h.date}</td>
                  <td>{h.name}</td>
                  {canEdit && <td><button className="link danger-link" onClick={async () => { await api(`/admin/holidays/${h.date}`, { method: 'DELETE' }); await load(); }}>Delete</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {canEdit && (
        <form className="card form-row" onSubmit={async (e) => { e.preventDefault(); try { await api('/admin/holidays', { method: 'POST', body: f }); setF({ date: '', name: '' }); await load(); } catch (err) { setError((err as Error).message); } }}>
          <h2>Add holiday</h2>
          <label>Date<input type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="grow">Name<input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <button className="btn primary">Add</button>
        </form>
      )}
    </>
  );
}

function Cscs({ canEdit }: { canEdit: boolean }) {
  const { meta, reloadMeta } = useApp();
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <p className="muted">Feeder classes (report section 1.5.1) are assigned CSC-wise. PUCSL may set different targets per feeder class; Feeder Class 1 has the toughest targets.</p>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Branch</th><th>CSC</th><th>Code</th><th>Feeder class</th></tr></thead>
            <tbody>
              {meta.cscs.slice().sort((a, b) => a.branchName.localeCompare(b.branchName) || a.name.localeCompare(b.name)).map((c) => (
                <tr key={c.id}>
                  <td>{c.branchName}</td>
                  <td>{c.name}</td>
                  <td className="mono">{c.code}</td>
                  <td>
                    {canEdit ? (
                      <select value={c.feederClass} onChange={async (e) => { try { await api(`/admin/cscs/${c.id}`, { method: 'PUT', body: { feederClass: Number(e.target.value) } }); await reloadMeta(); } catch (err) { setError((err as Error).message); } }}>
                        {[1, 2, 3, 4].map((f) => <option key={f} value={f}>FC{f}</option>)}
                      </select>
                    ) : `FC${c.feederClass}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

interface UserRow { id: number; username: string; fullName: string; role: string; cscId: number | null; branchId: number | null; active: boolean }

function Users() {
  const { meta, user: me } = useApp();
  const [rows, setRows] = useState<UserRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ username: '', fullName: '', role: 'CLERK', cscId: '', branchId: '', password: '' });
  const load = useCallback(() => api<UserRow[]>('/admin/users').then(setRows).catch((e) => setError(e.message)), []);
  useEffect(() => void load(), [load]);
  async function update(id: number, body: Record<string, unknown>) {
    try {
      setError(null);
      await api(`/admin/users/${id}`, { method: 'PUT', body });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <>
      <p className="muted">Users assigned to a CSC see only that CSC; branch-level users see their branch; GM, HEng, SDM, CE and admins see everything.</p>
      <ErrorBox error={error} />
      <div className="card flush">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Username</th><th>Name</th><th>Role</th><th>CSC</th><th>Branch</th><th>Active</th><th /></tr></thead>
            <tbody>
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.username}</td>
                  <td>{u.fullName}</td>
                  <td>
                    <select value={u.role} disabled={u.id === me.id} onChange={(e) => update(u.id, { role: e.target.value })}>
                      {meta.roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={u.cscId ?? ''} onChange={(e) => update(u.id, { cscId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">-</option>
                      {meta.cscs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={u.branchId ?? ''} onChange={(e) => update(u.id, { branchId: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">-</option>
                      {meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </td>
                  <td><input type="checkbox" checked={u.active} disabled={u.id === me.id} onChange={(e) => update(u.id, { active: e.target.checked })} /></td>
                  <td>
                    <button className="link" onClick={() => { const p = prompt(`New password for ${u.username} (min 8 characters)`); if (p) void update(u.id, { password: p }); }}>
                      Reset password
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <form
        className="card form-row"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            setError(null);
            await api('/admin/users', { method: 'POST', body: { ...f, cscId: f.cscId ? Number(f.cscId) : null, branchId: f.branchId ? Number(f.branchId) : null } });
            setF({ username: '', fullName: '', role: 'CLERK', cscId: '', branchId: '', password: '' });
            await load();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h2>Add user</h2>
        <label>Username<input required value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></label>
        <label>Full name<input required value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></label>
        <label>Role<select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{meta.roles.map((r) => <option key={r.code} value={r.code}>{r.label}</option>)}</select></label>
        <label>CSC<select value={f.cscId} onChange={(e) => setF({ ...f, cscId: e.target.value })}><option value="">-</option>{meta.cscs.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label>Branch<select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}><option value="">-</option>{meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        <label>Initial password<input type="password" required minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></label>
        <button className="btn primary">Create user</button>
      </form>
    </>
  );
}

export function AdminPage() {
  const { user } = useApp();
  const canEdit = user.role === 'ADMIN';
  const [tab, setTab] = useState<Tab>('targets');
  const tabs: [Tab, string][] = [
    ['targets', 'Targets'],
    ['approvals', 'Approval limits'],
    ['penalties', 'Compensation rules'],
    ['supply', 'Supply targets'],
    ['reasons', 'Reason codes'],
    ['holidays', 'Holidays'],
    ['cscs', 'CSCs & feeder classes'],
    ...(canEdit ? ([['users', 'Users']] as [Tab, string][]) : []),
  ];
  return (
    <>
      <PageHead title="Targets & setup" sub={canEdit ? 'Changes take effect immediately.' : 'Read-only - contact a system administrator to change targets.'} />
      <div className="tabs" role="tablist">
        {tabs.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'targets' && <Targets canEdit={canEdit} />}
      {tab === 'approvals' && <ApprovalLimits canEdit={canEdit} />}
      {tab === 'penalties' && <Penalties canEdit={canEdit} />}
      {tab === 'supply' && <SupplyTargets canEdit={canEdit} />}
      {tab === 'reasons' && <Reasons canEdit={canEdit} />}
      {tab === 'holidays' && <Holidays canEdit={canEdit} />}
      {tab === 'cscs' && <Cscs canEdit={canEdit} />}
      {tab === 'users' && canEdit && <Users />}
    </>
  );
}
