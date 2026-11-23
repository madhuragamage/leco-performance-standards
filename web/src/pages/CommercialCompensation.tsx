import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { fmtDate, fmtUnit, monthStartKey, todayKey } from '../format';
import type { Unit } from '../types';

interface Row {
  cscId: number; csc: string; branch: string; feederClass: number;
  payable: number; payableCount: number; accruing: number; accruingCount: number; byService: Record<string, number>; share: number | null;
}
interface Data {
  services: { code: string; name: string }[];
  totals: { payable: number; payableCount: number; accruing: number; accruingCount: number };
  rows: Row[];
}
interface Case {
  status: 'PAYABLE' | 'ACCRUING'; requestId: number; refNo: string; customerName: string; serviceName: string; measure: string;
  date: string; elapsed: number; unit: Unit; regulatoryTarget: number | null; amount: number; reasons: string[];
}

export const lkr = (n: number) => `LKR ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export function ShareBar({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="muted">-</span>;
  return (
    <span className="share">
      <span className="share-track"><span className="share-fill" style={{ width: `${Math.min(100, pct)}%` }} /></span>
      <span className="share-num">{pct.toFixed(1)}%</span>
    </span>
  );
}

type Preset = 'MONTH' | 'YTD' | 'CUSTOM';

function Cases({ cscId, from, to }: { cscId: number; from: string; to: string }) {
  const [cases, setCases] = useState<Case[] | null>(null);
  useEffect(() => {
    api<Case[]>(`/monitoring/compensation/by-csc/${cscId}?from=${from}&to=${to}`).then(setCases).catch(() => setCases([]));
  }, [cscId, from, to]);
  if (!cases) return <div className="muted small">Loading...</div>;
  if (!cases.length) return <div className="muted small">No cases.</div>;
  return (
    <table className="dense inner">
      <thead><tr><th>Ref no</th><th>Service / measure</th><th>Customer</th><th>Date</th><th className="num">Took</th><th className="num">Regulatory target</th><th className="num">Amount</th><th>Reasons given</th></tr></thead>
      <tbody>
        {cases.map((c, i) => (
          <tr key={i}>
            <td className="mono"><Link to={`/requests/${c.requestId}`}>{c.refNo}</Link>{c.status === 'ACCRUING' && <span className="badge badge-breached"> still open</span>}</td>
            <td>{c.measure}<div className="muted small">{c.serviceName}</div></td>
            <td>{c.customerName}</td>
            <td>{c.status === 'ACCRUING' ? `started ${fmtDate(c.date)}` : fmtDate(c.date)}</td>
            <td className="num">{fmtUnit(c.elapsed, c.unit)}</td>
            <td className="num">{fmtUnit(c.regulatoryTarget, c.unit)}</td>
            <td className="num strong">{lkr(c.amount)}</td>
            <td className="small">{c.reasons.join('; ') || '-'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function CommercialCompensationPage() {
  const { meta } = useApp();
  const [preset, setPreset] = useState<Preset>('YTD');
  const [custom, setCustom] = useState({ from: monthStartKey(), to: todayKey() });
  const [branchId, setBranchId] = useState<number | ''>('');
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(
    () => (preset === 'MONTH' ? { from: monthStartKey(), to: todayKey() } : preset === 'YTD' ? { from: `${todayKey().slice(0, 4)}-01-01`, to: todayKey() } : custom),
    [preset, custom],
  );

  useEffect(() => {
    setData(null);
    setError(null);
    const qs = new URLSearchParams({ ...range, ...(branchId ? { branchId: String(branchId) } : {}) });
    api<Data>(`/monitoring/compensation/by-csc?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [range, branchId]);

  const max = data ? Math.max(1, ...data.rows.map((r) => r.payable)) : 1;
  return (
    <>
      <PageHead
        title="Commercial quality compensation by CSC"
        sub="Compensation to customers for services completed past the regulatory target (report section 1.3), and what is still accruing on open services"
        actions={
          <div className="filters">
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Period">
              <option value="YTD">Year to date</option>
              <option value="MONTH">This month</option>
              <option value="CUSTOM">Custom period</option>
            </select>
            {preset === 'CUSTOM' && (
              <>
                <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
                <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
              </>
            )}
            <select value={branchId} onChange={(e) => setBranchId(e.target.value ? Number(e.target.value) : '')}>
              <option value="">All branches</option>
              {meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </div>
        }
      />
      <ErrorBox error={error} />
      {!data ? (
        !error && <div className="muted">Loading...</div>
      ) : (
        <>
          <section className="tiles">
            <div className={`tile ${data.totals.payable ? 'tile-bad' : 'tile-good'}`}>
              <div className="tile-label">Compensation payable ({range.from} to {range.to})</div>
              <div className="tile-value">{lkr(data.totals.payable)}</div>
              <div className="tile-sub">{data.totals.payableCount} case(s)</div>
            </div>
            <div className={`tile ${data.totals.accruing ? 'tile-warn' : 'tile-good'}`}>
              <div className="tile-label">Still accruing on open services</div>
              <div className="tile-value">{lkr(data.totals.accruing)}</div>
              <div className="tile-sub">{data.totals.accruingCount} open case(s) past the regulatory target</div>
            </div>
            <div className="tile">
              <div className="tile-label">CSCs contributing</div>
              <div className="tile-value">{data.rows.filter((r) => r.payable > 0).length}</div>
              <div className="tile-sub">{data.rows.filter((r) => r.accruing > 0).length} with open cases accruing</div>
            </div>
          </section>
          {data.rows.length === 0 ? (
            <Empty>No compensation in this period.</Empty>
          ) : (
            <section className="card flush">
              <div className="table-wrap">
                <table className="clickable">
                  <thead>
                    <tr>
                      <th className="num">#</th><th>CSC</th><th className="num">FC</th><th>Share of payable</th><th className="num">Payable</th><th className="num">Cases</th>
                      {data.services.map((s) => <th key={s.code} className="num" title={s.name}>{s.name.split(' - ')[0].split(' (')[0]}</th>)}
                      <th className="num">Accruing (open)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((r, i) => (
                      <Fragment key={r.cscId}>
                        <tr onClick={() => setOpen(open === r.cscId ? null : r.cscId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.cscId ? null : r.cscId)} aria-expanded={open === r.cscId}>
                          <td className="num">{i + 1}</td>
                          <td>{r.csc}<div className="muted small">{r.branch}</div></td>
                          <td className="num">{r.feederClass}</td>
                          <td><ShareBar pct={r.share} /></td>
                          <td className="num strong">{lkr(r.payable)}</td>
                          <td className="num">{r.payableCount}</td>
                          {data.services.map((s) => (
                            <td key={s.code} className="num">
                              {r.byService[s.code] ? <span className="bar-cell"><span style={{ width: `${(r.byService[s.code] / max) * 100}%` }} />{Math.round(r.byService[s.code]).toLocaleString('en-US')}</span> : <span className="muted">-</span>}
                            </td>
                          ))}
                          <td className={`num ${r.accruing ? 'text-warn' : ''}`}>{r.accruing ? `${lkr(r.accruing)} (${r.accruingCount})` : '-'}</td>
                        </tr>
                        {open === r.cscId && (
                          <tr className="detail-row">
                            <td colSpan={7 + data.services.length}><Cases cscId={r.cscId} from={range.from} to={range.to} /></td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                    <tr className="total-row">
                      <td colSpan={4}>Total</td>
                      <td className="num">{lkr(data.totals.payable)}</td>
                      <td className="num">{data.totals.payableCount}</td>
                      {data.services.map((s) => <td key={s.code} className="num">{Math.round(data.rows.reduce((t, r) => t + (r.byService[s.code] ?? 0), 0)).toLocaleString('en-US')}</td>)}
                      <td className="num">{lkr(data.totals.accruing)}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <p className="muted small">Click a CSC to see the individual cases and the reasons recorded for not meeting the target.</p>
        </>
      )}
    </>
  );
}
