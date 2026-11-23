import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CscSelect, ErrorBox, Meter, PageHead } from '../components';
import { useApp } from '../context';
import { fmtLkr, fmtPct, fmtUnit, monthStartKey, todayKey } from '../format';
import type { Dashboard, Stat } from '../types';

function Tile({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`tile ${tone ? `tile-${tone}` : ''}`}>
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {sub && <div className="tile-sub">{sub}</div>}
    </div>
  );
}

function TrendChart({ data }: { data: Dashboard['trend'] }) {
  const w = 720;
  const h = 200;
  const pad = { l: 36, r: 12, t: 12, b: 28 };
  const iw = w - pad.l - pad.r;
  const ih = h - pad.t - pad.b;
  const bw = iw / data.length;
  const y = (v: number) => pad.t + ih - (v / 100) * ih;
  const line = (key: 'internalPct' | 'regulatoryPct') =>
    data
      .map((d, i) => (d[key] === null ? null : `${pad.l + bw * i + bw / 2},${y(d[key]!)}`))
      .filter(Boolean)
      .join(' ');
  const maxTotal = Math.max(1, ...data.map((d) => d.total));
  return (
    <div className="chart">
      <div className="legend">
        <span><i className="sw sw-reg" /> Within regulatory target</span>
        <span><i className="sw sw-int" /> Within LECO target</span>
        <span><i className="sw sw-vol" /> Closed volume</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="12-month compliance trend">
        {[0, 25, 50, 75, 100].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={w - pad.r} y1={y(g)} y2={y(g)} className="grid" />
            <text x={pad.l - 6} y={y(g) + 4} className="axis" textAnchor="end">{g}%</text>
          </g>
        ))}
        {data.map((d, i) => (
          <g key={d.month}>
            <rect x={pad.l + bw * i + bw * 0.2} width={bw * 0.6} y={pad.t + ih - (d.total / maxTotal) * ih * 0.5} height={(d.total / maxTotal) * ih * 0.5} className="vol">
              <title>{`${d.month}: ${d.total} closed`}</title>
            </rect>
            <text x={pad.l + bw * i + bw / 2} y={h - 8} className="axis" textAnchor="middle">{d.month.slice(5)}/{d.month.slice(2, 4)}</text>
          </g>
        ))}
        <polyline points={line('internalPct')} className="ln-int" />
        <polyline points={line('regulatoryPct')} className="ln-reg" />
        {data.map((d, i) =>
          d.regulatoryPct === null ? null : (
            <circle key={d.month} cx={pad.l + bw * i + bw / 2} cy={y(d.regulatoryPct)} r={3.5} className="pt-reg">
              <title>{`${d.month}: regulatory ${fmtPct(d.regulatoryPct)}, LECO ${fmtPct(d.internalPct)}`}</title>
            </circle>
          ),
        )}
      </svg>
    </div>
  );
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const qTone = (p: number | null) => (p === null ? 'none' : p >= 90 ? 'good' : p >= 75 ? 'warn' : 'bad');

function QualityHalf({ label, s, regulated }: { label: string; s: Stat; regulated: boolean }) {
  return (
    <div className="q-half">
      <div className="q-period">{label}</div>
      <div className={`q-value q-${qTone(s.total ? s.internalPct : null)}`}>{s.total ? fmtPct(s.internalPct) : '-'}</div>
      <div className="q-sub">
        {s.total ? (
          <>
            {regulated ? <>Reg. {fmtPct(s.regulatoryPct)} - </> : null}
            {s.total} closed
          </>
        ) : (
          'nothing closed'
        )}
      </div>
    </div>
  );
}

function QualityTile({ name, month, ytd, regulated, monthName, overall }: { name: string; month: Stat; ytd: Stat; regulated: boolean; monthName: string; overall?: boolean }) {
  const delta = month.total && ytd.total && month.internalPct !== null && ytd.internalPct !== null ? month.internalPct - ytd.internalPct : null;
  return (
    <div className={`q-tile ${overall ? 'q-overall' : ''}`}>
      <div className="q-name" title={name}>
        {name}
        {delta !== null && Math.abs(delta) >= 0.5 && (
          <span className={`q-delta ${delta > 0 ? 'up' : 'down'}`} title="This month compared with the year to date">
            {delta > 0 ? '▲' : '▼'} {Math.abs(delta).toFixed(1)}
          </span>
        )}
      </div>
      <div className="q-body">
        <QualityHalf label={monthName} s={month} regulated={regulated} />
        <QualityHalf label="Year to date" s={ytd} regulated={regulated} />
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { meta } = useApp();
  const [from, setFrom] = useState(monthStartKey());
  const [to, setTo] = useState(todayKey());
  const [branchId, setBranchId] = useState<number | ''>('');
  const [cscId, setCscId] = useState<number | ''>('');
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const qs = new URLSearchParams({ from, to, ...(cscId ? { cscId: String(cscId) } : {}), ...(branchId ? { branchId: String(branchId) } : {}) });
    setError(null);
    api<Dashboard>(`/monitoring/dashboard?${qs}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [from, to, cscId, branchId]);

  const portalShare = data ? data.intake.filter((i) => i.source === 'PORTAL').reduce((s, i) => s + i.count, 0) : 0;
  const intakeTotal = data ? data.intake.reduce((s, i) => s + i.count, 0) : 0;
  const tone = (p: number | null) => (p === null ? undefined : p >= 90 ? 'good' : p >= 75 ? 'warn' : 'bad');

  return (
    <>
      <PageHead
        title="Performance dashboard"
        sub="Commercial quality - services closed in the period, and services still open now"
        actions={
          <div className="filters">
            <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value ? Number(e.target.value) : ''); setCscId(''); }}>
              <option value="">All branches</option>
              {meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <CscSelect value={cscId} onChange={setCscId} branchId={branchId} />
          </div>
        }
      />
      <ErrorBox error={error} />
      {!data ? (
        <div className="muted">Loading...</div>
      ) : (
        <>
          <section className="tiles">
            <Tile label="Measures closed" value={data.overall.total} sub={`${intakeTotal} new requests, ${portalShare} via portal`} />
            <Tile label="Within LECO target" value={fmtPct(data.overall.internalPct)} sub={`${data.overall.internalOk} of ${data.overall.total}`} tone={tone(data.overall.internalPct)} />
            <Tile label="Within regulatory target" value={fmtPct(data.overall.regulatoryPct)} sub={`${data.overall.breached} breaches`} tone={tone(data.overall.regulatoryPct)} />
            <Tile label="Compensation payable" value={fmtLkr(data.overall.penalty)} sub="Closed in period" tone={data.overall.penalty > 0 ? 'bad' : 'good'} />
            <Tile label="Customer rating" value={data.feedback.average ? `${data.feedback.average} / 5` : '-'} sub={`${data.feedback.count} ratings`} />
          </section>

          <section className="tiles">
            <Tile label="Open - running clocks" value={data.open.running} />
            <Tile label="Open - LECO target exceeded" value={data.open.internalExceeded} tone={data.open.internalExceeded ? 'warn' : 'good'} />
            <Tile label="Open - regulatory breach" value={data.open.breached} tone={data.open.breached ? 'bad' : 'good'} />
            <Tile label="Awaiting customer" value={data.open.paused} sub="Non-conformity / wayleave / objection" />
            <Tile label="Compensation accruing" value={fmtLkr(data.open.accruedPenalty)} tone={data.open.accruedPenalty ? 'bad' : 'good'} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Service quality by category</h2>
              <span className="muted small">
                % of measures completed within the LECO target (regulatory compliance below), month to date and year to date as at {data.serviceQuality.asOf}. ▲▼ compares the month with the year to date.
              </span>
            </div>
            <div className="q-grid">
              <QualityTile
                overall
                name="All services"
                month={data.serviceQuality.overall.month}
                ytd={data.serviceQuality.overall.ytd}
                regulated
                monthName={MONTHS[Number(data.serviceQuality.monthLabel.slice(5, 7)) - 1]}
              />
              {data.serviceQuality.services.map((s) => (
                <QualityTile key={s.serviceType} name={s.serviceName} month={s.month} ytd={s.ytd} regulated={s.regulated} monthName={MONTHS[Number(data.serviceQuality.monthLabel.slice(5, 7)) - 1]} />
              ))}
            </div>
          </section>

          <section className="card">
            <h2>12-month trend</h2>
            <TrendChart data={data.trend} />
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>By service measure</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Measure</th><th className="num">Closed</th><th>LECO target</th><th>Regulatory</th><th className="num">Avg</th><th className="num">Compensation</th></tr>
                  </thead>
                  <tbody>
                    {data.byClock.length === 0 && <tr><td colSpan={6} className="muted">Nothing closed in this period.</td></tr>}
                    {data.byClock.sort((a, b) => a.clockKey.localeCompare(b.clockKey)).map((c) => (
                      <tr key={c.clockKey}>
                        <td>
                          <div>{c.label}</div>
                          <div className="muted small">{c.serviceName}{c.regulated ? '' : ' - internal only'}</div>
                        </td>
                        <td className="num">{c.total}</td>
                        <td><Meter value={c.internalPct} /></td>
                        <td>{c.regulated ? <Meter value={c.regulatoryPct} /> : <span className="muted">n/a</span>}</td>
                        <td className="num">{fmtUnit(c.avgElapsed, c.unit)}</td>
                        <td className="num">{c.penalty ? fmtLkr(c.penalty) : '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="card">
              <h2>Open services</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Service</th><th className="num">Running</th><th className="num">LECO exceeded</th><th className="num">Breached</th><th className="num">Awaiting customer</th></tr>
                  </thead>
                  <tbody>
                    {data.open.byService.length === 0 && <tr><td colSpan={5} className="muted">No open services.</td></tr>}
                    {data.open.byService.map((s) => (
                      <tr key={s.serviceType}>
                        <td><Link to={`/pending?serviceType=${s.serviceType}`}>{s.serviceName}</Link></td>
                        <td className="num">{s.running}</td>
                        <td className="num">{s.internalExceeded || '-'}</td>
                        <td className={`num ${s.breached ? 'text-bad' : ''}`}>{s.breached || '-'}</td>
                        <td className="num">{s.paused || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>

          <section className="card">
            <h2>By customer service centre</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Branch</th><th>CSC</th><th className="num">Feeder class</th><th className="num">Closed</th><th>LECO target</th><th>Regulatory</th><th className="num">Compensation</th></tr>
                </thead>
                <tbody>
                  {data.byCsc.length === 0 && <tr><td colSpan={7} className="muted">Nothing closed in this period.</td></tr>}
                  {data.byCsc.map((c) => (
                    <tr key={c.cscId}>
                      <td>{c.branch}</td>
                      <td>{c.name}</td>
                      <td className="num">{c.feederClass}</td>
                      <td className="num">{c.total}</td>
                      <td><Meter value={c.internalPct} /></td>
                      <td><Meter value={c.regulatoryPct} /></td>
                      <td className="num">{c.penalty ? fmtLkr(c.penalty) : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </>
  );
}
