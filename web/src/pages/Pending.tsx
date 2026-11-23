import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, download } from '../api';
import { ComplianceBadge, CscSelect, Empty, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { fmtDate, fmtLkr, fmtUnit, remainingText, todayKey } from '../format';
import type { PendingRow } from '../types';

export function PendingPage() {
  const { meta } = useApp();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const serviceType = params.get('serviceType') ?? '';
  const compliance = params.get('compliance') ?? '';
  const cscId = params.get('cscId') ? Number(params.get('cscId')) : '';
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PendingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const qs = useMemo(() => {
    const p = new URLSearchParams();
    if (serviceType) p.set('serviceType', serviceType);
    if (compliance) p.set('compliance', compliance);
    if (cscId) p.set('cscId', String(cscId));
    return p;
  }, [serviceType, compliance, cscId]);

  useEffect(() => {
    setRows(null);
    api<PendingRow[]>(`/monitoring/pending?${qs}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  }, [qs]);

  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };

  const filtered = (rows ?? []).filter((r) => !q || `${r.refNo} ${r.customerName} ${r.portalReference ?? ''}`.toLowerCase().includes(q.toLowerCase()));
  const counts = {
    breached: (rows ?? []).filter((r) => r.compliance === 'BREACHED').length,
    exceeded: (rows ?? []).filter((r) => r.compliance === 'INTERNAL_EXCEEDED').length,
  };

  return (
    <>
      <PageHead
        title="Customer pending service monitoring"
        sub={rows ? `${filtered.length} running measures - ${counts.breached} past regulatory target, ${counts.exceeded} past LECO target` : 'Loading...'}
        actions={
          <button className="btn" onClick={() => download(`/monitoring/pending?${qs}&format=csv`, `pending-services-${todayKey()}.csv`).catch((e) => setError(e.message))}>
            Export CSV
          </button>
        }
      />
      <div className="filters bar">
        <select value={serviceType} onChange={(e) => set('serviceType', e.target.value)}>
          <option value="">All services</option>
          {meta.services.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <CscSelect value={cscId} onChange={(v) => set('cscId', v ? String(v) : '')} />
        <select value={compliance} onChange={(e) => set('compliance', e.target.value)}>
          <option value="">Any status</option>
          <option value="BREACHED">Regulatory breach</option>
          <option value="INTERNAL_EXCEEDED">LECO target exceeded</option>
          <option value="WITHIN_INTERNAL">Within LECO target</option>
          <option value="NO_TARGET">No target set</option>
        </select>
        <input type="search" placeholder="Search ref no, customer..." value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      {rows && filtered.length === 0 ? (
        <Empty>No pending services match these filters.</Empty>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="clickable">
              <thead>
                <tr>
                  <th>Ref no</th>
                  <th>Measure</th>
                  <th>CSC</th>
                  <th>Customer</th>
                  <th>Started</th>
                  <th className="num">Elapsed</th>
                  <th>Present status</th>
                  <th className="num">To LECO target</th>
                  <th className="num">To regulatory target</th>
                  <th>Status</th>
                  <th>Reason codes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={`${r.requestId}-${r.clockKey}`} onClick={() => nav(`/requests/${r.requestId}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/requests/${r.requestId}`)}>
                    <td className="mono">{r.refNo}{r.portalReference && <div className="muted small">{r.portalReference}</div>}</td>
                    <td>{r.clockLabel}<div className="muted small">{r.serviceName}</div></td>
                    <td>{r.cscName}<div className="muted small">FC{r.feederClass}</div></td>
                    <td>{r.customerName}{r.natureOfSupply && <div className="muted small">{meta.natureLabels[r.natureOfSupply]}</div>}</td>
                    <td>{fmtDate(r.startedAt)}</td>
                    <td className="num">{fmtUnit(r.elapsed, r.unit)}{r.excluded > 0 && <div className="muted small">-{fmtUnit(r.excluded, r.unit)} excl.</div>}</td>
                    <td>{r.presentStatus}</td>
                    <td className={`num ${(r.remainingInternal ?? 0) < 0 ? 'text-warn' : ''}`}>{r.mode === 'MIN_LEAD' ? `${fmtUnit(r.elapsed, r.unit)} notice` : remainingText(r.remainingInternal, r.unit)}</td>
                    <td className={`num ${(r.remainingRegulatory ?? 0) < 0 ? 'text-bad' : ''}`}>
                      {r.mode === 'MIN_LEAD' ? `min ${fmtUnit(r.regulatoryTarget, r.unit)}` : remainingText(r.remainingRegulatory, r.unit)}
                      {r.provisional && r.regulatoryTarget !== null && <div className="muted small">provisional</div>}
                    </td>
                    <td>
                      <ComplianceBadge c={r.compliance} paused={r.paused} />
                      {r.accruedPenalty > 0 && <div className="small text-bad">{fmtLkr(r.accruedPenalty)}</div>}
                    </td>
                    <td className="mono small">{r.reasonCodes.join(' ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
