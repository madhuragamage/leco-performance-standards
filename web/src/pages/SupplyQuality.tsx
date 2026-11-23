import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { CscSelect, Empty, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { todayKey } from '../format';

interface Fig { hours: number; interruptions: number; saidi: number | null; saifi: number | null }
interface IndexSet { avgConsumers: number; categories: Record<string, Fig>; leco: Fig; lecoSustained: Fig; ceb: Fig; maifi: number | null }
interface Assess { target: number; actual: number; annualised: number; status: 'EXCEEDED' | 'AT_RISK' | 'ON_COURSE' }
interface Category { code: string; label: string; owner: 'LECO' | 'CEB'; voltage: string; type: string }
interface Indices {
  period: { from: string; to: string; months: number; days: number; annualiseFactor: number };
  coverage: { firstDate: string | null; lastDate: string | null; daysWithData: number; transformers: number };
  categories: Category[];
  overall: IndexSet;
  byFeederClass: (IndexSet & { feederClass: number; cscs: number; target: { saidi: Assess | null; saifi: Assess | null; provisional: boolean } | null })[];
  byCsc: (IndexSet & { cscId: number; csc: string; branch: string; feederClass: number })[];
  trend: ({ month: string } & Record<string, { saidi: number | null; saifi: number | null } | string>)[];
}
interface Durations {
  exceeding: number;
  transformersWithOutages: number;
  rows: { transformerId: number; code: string; name: string | null; csc: string; feederClass: number; consumers: number; durationHours: number; interruptions: number; limitHours: number | null; exceeds: boolean }[];
}

type Preset = 'YTD' | 'MONTH' | 'LAST_MONTH' | 'CUSTOM';
const n2 = (v: number | null | undefined) => (v === null || v === undefined ? '-' : v.toFixed(2));
const int = (v: number) => Math.round(v).toLocaleString('en-US');
const STATUS: Record<Assess['status'], { label: string; cls: string }> = {
  EXCEEDED: { label: 'Approved level exceeded', cls: 'badge-breached' },
  AT_RISK: { label: 'At risk (annualised)', cls: 'badge-internal_exceeded' },
  ON_COURSE: { label: 'On course', cls: 'badge-within_internal' },
};

function rangeFor(p: Preset, custom: { from: string; to: string }) {
  const today = todayKey();
  if (p === 'YTD') return { from: `${today.slice(0, 4)}-01-01`, to: today };
  if (p === 'MONTH') return { from: `${today.slice(0, 8)}01`, to: today };
  if (p === 'LAST_MONTH') {
    const d = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
    d.setUTCDate(0);
    const end = d.toISOString().slice(0, 10);
    return { from: `${end.slice(0, 8)}01`, to: end };
  }
  return custom;
}

function IndexTable({ data, measure, show }: { data: Indices; measure: 'saidi' | 'saifi'; show: 'index' | 'raw' }) {
  const leco = data.categories.filter((c) => c.owner === 'LECO');
  const raw = (f: Fig) => int(measure === 'saidi' ? f.hours : f.interruptions);
  const val = (f: Fig) => (show === 'raw' ? raw(f) : n2(f[measure]));
  const unit = measure === 'saidi' ? (show === 'raw' ? 'Cons.hrs' : 'hours / consumer') : show === 'raw' ? 'Cons. interruptions' : 'interruptions / consumer';
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Feeder class</th>
            <th className="num">Average consumers</th>
            {leco.map((c) => <th key={c.code} className="num" title={c.label}>{c.code}</th>)}
            <th className="num">Total LECO</th>
            <th className="num">CEB related</th>
            {show === 'index' && <><th className="num">Approved (annual)</th><th className="num">Annualised</th><th>Status</th></>}
          </tr>
        </thead>
        <tbody>
          {data.byFeederClass.map((r) => {
            const a = r.target?.[measure] ?? null;
            return (
              <tr key={r.feederClass}>
                <td>FC{r.feederClass} <span className="muted small">({r.cscs} CSC{r.cscs > 1 ? 's' : ''})</span></td>
                <td className="num">{int(r.avgConsumers)}</td>
                {leco.map((c) => <td key={c.code} className="num">{val(r.categories[c.code])}</td>)}
                <td className="num strong">{val(r.leco)}</td>
                <td className="num muted">{val(r.ceb)}</td>
                {show === 'index' && (
                  <>
                    <td className="num">{a ? a.target : '-'}{r.target?.provisional && a ? <span className="muted small"> *</span> : null}</td>
                    <td className="num">{a ? n2(a.annualised) : '-'}</td>
                    <td>{a ? <span className={`badge ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span> : <span className="muted">No target</span>}</td>
                  </>
                )}
              </tr>
            );
          })}
          <tr className="total-row">
            <td>Grand total</td>
            <td className="num">{int(data.overall.avgConsumers)}</td>
            {leco.map((c) => <td key={c.code} className="num">{val(data.overall.categories[c.code])}</td>)}
            <td className="num strong">{val(data.overall.leco)}</td>
            <td className="num muted">{val(data.overall.ceb)}</td>
            {show === 'index' && <td colSpan={3} />}
          </tr>
        </tbody>
      </table>
      <p className="muted small">Values in {unit}. "Total LECO" includes momentary interruptions, as in the report's tables (section 12.1).</p>
    </div>
  );
}

export function SupplyQualityPage() {
  const { meta, user } = useApp();
  const [preset, setPreset] = useState<Preset>('YTD');
  const [custom, setCustom] = useState({ from: `${todayKey().slice(0, 4)}-01-01`, to: todayKey() });
  const [branchId, setBranchId] = useState<number | ''>('');
  const [cscId, setCscId] = useState<number | ''>('');
  const [show, setShow] = useState<'index' | 'raw'>('index');
  const [data, setData] = useState<Indices | null>(null);
  const [dur, setDur] = useState<Durations | null>(null);
  const [error, setError] = useState<string | null>(null);
  const range = useMemo(() => rangeFor(preset, custom), [preset, custom]);

  useEffect(() => {
    const qs = new URLSearchParams({ from: range.from, to: range.to, ...(cscId ? { cscId: String(cscId) } : {}), ...(branchId ? { branchId: String(branchId) } : {}) });
    setData(null);
    setError(null);
    api<Indices>(`/supply/indices?${qs}`).then(setData).catch((e) => setError(e.message));
    api<Durations>(`/supply/transformer-durations?${qs}`).then(setDur).catch(() => setDur(null));
  }, [range, cscId, branchId]);

  const canUpload = ['ADMIN', 'CE', 'HENG', 'SDM'].includes(user.role);
  const cebShare = data && data.overall.leco.hours + data.overall.ceb.hours > 0 ? (data.overall.ceb.hours / (data.overall.leco.hours + data.overall.ceb.hours)) * 100 : null;

  return (
    <>
      <PageHead
        title="Supply quality"
        sub="Overall indices from transformer-wise interruption data (report section 12)"
        actions={
          <div className="filters">
            <select value={preset} onChange={(e) => setPreset(e.target.value as Preset)} aria-label="Period">
              <option value="YTD">Year to date</option>
              <option value="MONTH">This month</option>
              <option value="LAST_MONTH">Last month</option>
              <option value="CUSTOM">Custom period</option>
            </select>
            {preset === 'CUSTOM' && (
              <>
                <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="From" />
                <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="To" />
              </>
            )}
            <select value={branchId} onChange={(e) => { setBranchId(e.target.value ? Number(e.target.value) : ''); setCscId(''); }}>
              <option value="">All branches</option>
              {meta.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
            <CscSelect value={cscId} onChange={setCscId} branchId={branchId} />
            {canUpload && <Link className="btn" to="/supply/upload">Upload data</Link>}
          </div>
        }
      />
      <ErrorBox error={error} />
      {!data ? (
        <div className="muted">Loading...</div>
      ) : data.coverage.transformers === 0 ? (
        <Empty>No transformer register loaded yet. {canUpload ? <Link to="/supply/upload">Upload the transformer register and interruption data</Link> : 'Ask the Control Engineer to upload the data.'}</Empty>
      ) : (
        <>
          <p className="muted small">
            {range.from} to {range.to} - {data.coverage.daysWithData} day(s) with data; data loaded up to <strong>{data.coverage.lastDate ?? 'none'}</strong> - {int(data.coverage.transformers)} transformers.
            {data.period.annualiseFactor > 1 && ` Annualised = period value x ${data.period.annualiseFactor} (${data.period.days} days).`}
          </p>

          <section className="tiles">
            {data.byFeederClass.map((r) => {
              const a = r.target?.saidi;
              return (
                <div key={r.feederClass} className={`tile ${a ? (a.status === 'EXCEEDED' ? 'tile-bad' : a.status === 'AT_RISK' ? 'tile-warn' : 'tile-good') : ''}`}>
                  <div className="tile-label">Feeder class {r.feederClass} - LECO SAIDI</div>
                  <div className="tile-value">{n2(r.leco.saidi)} h</div>
                  <div className="tile-sub">{a ? `approved ${a.target} h/yr - annualised ${n2(a.annualised)}` : 'no approved level'} - SAIFI {n2(r.leco.saifi)}</div>
                </div>
              );
            })}
            <div className="tile">
              <div className="tile-label">CEB-related share of outage hours</div>
              <div className="tile-value">{cebShare === null ? '-' : `${cebShare.toFixed(1)}%`}</div>
              <div className="tile-sub">CEB SAIDI {n2(data.overall.ceb.saidi)} h - MAIFI {n2(data.overall.maifi)}</div>
            </div>
          </section>

          <div className="seg" role="radiogroup" aria-label="Show">
            <button className={show === 'index' ? 'on' : ''} onClick={() => setShow('index')}>Indices</button>
            <button className={show === 'raw' ? 'on' : ''} onClick={() => setShow('raw')}>Consumer hours / interruptions</button>
          </div>

          <section className="card">
            <h2>SAIDI by feeder class {show === 'raw' && '- consumer hours lost'}</h2>
            <IndexTable data={data} measure="saidi" show={show} />
          </section>
          <section className="card">
            <h2>SAIFI by feeder class {show === 'raw' && '- consumer interruptions'}</h2>
            <IndexTable data={data} measure="saifi" show={show} />
          </section>

          <div className="grid-2">
            <section className="card">
              <h2>CEB-related interruptions</h2>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>Feeder class</th>{data.categories.filter((c) => c.owner === 'CEB').map((c) => <th key={c.code} className="num" title={c.label}>{c.code}</th>)}<th className="num">Total CEB</th></tr>
                  </thead>
                  <tbody>
                    {data.byFeederClass.map((r) => (
                      <tr key={r.feederClass}>
                        <td>FC{r.feederClass}</td>
                        {data.categories.filter((c) => c.owner === 'CEB').map((c) => <td key={c.code} className="num">{n2(r.categories[c.code].saidi)}</td>)}
                        <td className="num strong">{n2(r.ceb.saidi)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted small">SAIDI, hours per consumer. Shown separately; not included in LECO totals.</p>
            </section>

            <section className="card">
              <h2>Monthly LECO SAIDI {data.period.to.slice(0, 4)}</h2>
              <div className="table-wrap">
                <table className="dense">
                  <thead><tr><th>Month</th><th className="num">All</th><th className="num">FC1</th><th className="num">FC2</th><th className="num">FC3</th><th className="num">FC4</th></tr></thead>
                  <tbody>
                    {data.trend.map((t) => (
                      <tr key={t.month as string}>
                        <td>{t.month as string}</td>
                        {['all', 'fc1', 'fc2', 'fc3', 'fc4'].map((k) => <td key={k} className="num">{n2((t[k] as { saidi: number | null }).saidi)}</td>)}
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
                  <tr><th>Branch</th><th>CSC</th><th className="num">FC</th><th className="num">Avg consumers</th><th className="num">LECO SAIDI</th><th className="num">LECO SAIFI</th><th className="num">MAIFI</th><th className="num">CEB SAIDI</th></tr>
                </thead>
                <tbody>
                  {data.byCsc.map((c) => (
                    <tr key={c.cscId}>
                      <td>{c.branch}</td>
                      <td>{c.csc}</td>
                      <td className="num">{c.feederClass}</td>
                      <td className="num">{int(c.avgConsumers)}</td>
                      <td className="num strong">{n2(c.leco.saidi)}</td>
                      <td className="num">{n2(c.leco.saifi)}</td>
                      <td className="num">{n2(c.maifi)}</td>
                      <td className="num muted">{n2(c.ceb.saidi)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {dur && (
            <section className="card">
              <div className="card-head">
                <h2>Transformers with the longest LECO interruption duration</h2>
                <span className="muted small">
                  {dur.exceeding} of {dur.transformersWithOutages} transformers above the specified annual duration (section 12.3). Duration = consumer hours / consumers on the transformer.
                </span>
              </div>
              <div className="table-wrap">
                <table className="dense">
                  <thead><tr><th>TF ID</th><th>CSC</th><th className="num">FC</th><th className="num">Consumers</th><th className="num">Duration (h)</th><th className="num">Interruptions</th><th className="num">Specified (h/yr)</th><th /></tr></thead>
                  <tbody>
                    {dur.rows.map((r) => (
                      <tr key={r.transformerId}>
                        <td className="mono">{r.code}{r.name && <span className="muted small"> {r.name}</span>}</td>
                        <td>{r.csc}</td>
                        <td className="num">{r.feederClass}</td>
                        <td className="num">{r.consumers}</td>
                        <td className={`num ${r.exceeds ? 'text-bad strong' : ''}`}>{r.durationHours.toFixed(1)}</td>
                        <td className="num">{r.interruptions}</td>
                        <td className="num">{r.limitHours ?? '-'}</td>
                        <td>{r.exceeds && <span className="badge badge-breached">Exceeds</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <p className="muted small">* Approved levels are provisional until PUCSL sets the base data. Edit them under Targets &amp; setup → Supply targets.</p>
        </>
      )}
    </>
  );
}
