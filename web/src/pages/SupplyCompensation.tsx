import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { todayKey } from '../format';

interface Overall { saidiExcess: number; saifiExcess: number; cSaidi: number; cSaifi: number; compensation: number; basis: 'SAIDI' | 'SAIFI' | null }
interface Eens { excessKwh: number | null; compensation: number | null }
interface FcRow {
  feederClass: number; avgConsumers: number; consumerHours: number; consumerInterruptions: number;
  saidi: number; saifi: number; projectedSaidi: number; projectedSaifi: number; approvedSaidi: number | null; approvedSaifi: number | null;
  energySalesKwh: number | null; supplyCost: number | null; missing: string[]; asAt: Overall | null; projected: Overall | null;
  eens: { actualKwh: number; projectedKwh: number; approvedKwh: number | null; cens: number | null; asAt: Eens; projected: Eens };
}
interface IndRow {
  transformerId: number; code: string; name: string | null; csc: string; branch: string; feederClass: number; consumers: number; energyKwh: number; energyEstimated: boolean;
  durationHours: number; projectedHours: number; specifiedHours: number; supplyCost: number;
  asAt: { exceedingHours: number; compensation: number }; projected: { exceedingHours: number; compensation: number };
}
interface Comp {
  year: number; from: string; to: string; complete: boolean; days: number; factor: number;
  overall: FcRow[];
  individual: { rows: IndRow[]; qualifyingAsAt: number; qualifyingProjected: number; estimatedEnergy: number };
  totals: { overall: { asAt: number; projected: number }; eens: { asAt: number; projected: number }; individual: { asAt: number; projected: number } };
}
interface YearData { year: number; feederClass: number; energySalesKwh: number | null; supplyCost: number | null; cens: number | null; approvedEensMwh: number | null; note: string | null }

const lkr = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `LKR ${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? '-' : n.toLocaleString('en-US', { maximumFractionDigits: d }));

function BaseData({ year, canEdit, onSaved }: { year: number; canEdit: boolean; onSaved: () => void }) {
  const [rows, setRows] = useState<YearData[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    api<YearData[]>(`/supply/year-data?year=${year}`).then(setRows).catch((e) => setError(e.message));
  }, [year]);
  const set = (fc: number, k: keyof YearData, v: string) => setRows(rows.map((r) => (r.feederClass === fc ? { ...r, [k]: v.trim() === '' ? null : Number(v) } : r)));
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      setError(null);
      await api('/supply/year-data', { method: 'PUT', body: rows.map(({ year: y, feederClass, energySalesKwh, supplyCost, cens, approvedEensMwh, note }) => ({ year: y, feederClass, energySalesKwh, supplyCost, cens, approvedEensMwh, note })) });
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  const missing = rows.some((r) => r.energySalesKwh === null || r.supplyCost === null);
  return (
    <section className="card">
      <div className="card-head">
        <h2>Base data for {year}</h2>
        <button className="link" onClick={() => setOpen(!open)}>{open ? 'Hide' : missing ? 'Enter base data' : 'Show / edit'}</button>
      </div>
      {!open && <p className="muted small">Energy sales, supply cost, cost of energy not supplied and approved EENS per feeder class. Approved SAIDI / SAIFI and individual hours are under Targets &amp; setup → Supply targets.</p>}
      {open && (
        <form onSubmit={save}>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Feeder class</th><th>Energy sales (kWh/yr)</th><th>Supply cost (LKR/kWh)</th><th>CENS (LKR/kWh)</th><th>Approved EENS (MWh)</th><th>Note</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.feederClass}>
                    <td>FC{r.feederClass}</td>
                    {(['energySalesKwh', 'supplyCost', 'cens', 'approvedEensMwh'] as const).map((k) => (
                      <td key={k}>
                        {canEdit ? <input type="number" step="any" min={0} className={k === 'energySalesKwh' ? 'num-input wide' : 'num-input'} value={r[k] ?? ''} onChange={(e) => set(r.feederClass, k, e.target.value)} aria-label={`FC${r.feederClass} ${k}`} /> : num(r[k])}
                      </td>
                    ))}
                    <td className="small muted">{r.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ErrorBox error={error} />
          {canEdit ? <div className="form-actions"><button className="btn primary">Save and recalculate</button></div> : <p className="muted small">Only the administrator can change base data.</p>}
        </form>
      )}
    </section>
  );
}

function csvExport(c: Comp) {
  const head = ['TF ID', 'Name', 'Branch', 'CSC', 'Feeder class', 'Consumers', 'Annual energy kWh', 'Energy estimated', 'Duration to date (h)', 'Projected duration (h)', 'Specified (h)', 'Exceeding to date (h)', 'Compensation to date (LKR)', 'Projected exceeding (h)', 'Projected compensation (LKR)'];
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [head, ...c.individual.rows.map((r) => [r.code, r.name, r.branch, r.csc, r.feederClass, r.consumers, r.energyKwh, r.energyEstimated ? 'Y' : 'N', r.durationHours, r.projectedHours, r.specifiedHours, r.asAt.exceedingHours, r.asAt.compensation, r.projected.exceedingHours, r.projected.compensation])];
  const url = URL.createObjectURL(new Blob([lines.map((l) => l.map(esc).join(',')).join('\r\n')], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `individual-supply-compensation-${c.year}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export function SupplyCompensationPage() {
  const { user } = useApp();
  const thisYear = Number(todayKey().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [data, setData] = useState<Comp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setData(null);
    setError(null);
    api<Comp>(`/supply/compensation?year=${year}`).then(setData).catch((e) => setError(e.message));
  }, [year]);
  useEffect(load, [load]);

  const t = data?.totals;
  const label = data?.complete ? 'For the year' : 'As at today';
  return (
    <>
      <PageHead
        title="Supply quality compensation"
        sub="Report section 12: overall (SAIDI / SAIFI), EENS and individual supply quality"
        actions={
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
            {Array.from({ length: 5 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        }
      />
      <BaseData year={year} canEdit={user.role === 'ADMIN'} onSaved={load} />
      <ErrorBox error={error} />
      {!data ? (
        !error && <div className="muted">Calculating...</div>
      ) : (
        <>
          <p className="muted small">
            {data.from} to {data.to} ({data.days} days).{' '}
            {data.complete
              ? 'The year is complete - these are the final figures.'
              : `"As at today" uses the indices so far (what would be payable if the year ended today); "projected" annualises them (x ${data.factor}) for the full year.`}
          </p>
          <section className="tiles">
            <div className={`tile ${t!.overall.projected ? 'tile-bad' : 'tile-good'}`}>
              <div className="tile-label">Overall (SAIDI / SAIFI)</div>
              <div className="tile-value">{lkr(t!.overall.asAt)}</div>
              {!data.complete && <div className="tile-sub">Projected {lkr(t!.overall.projected)}</div>}
            </div>
            <div className={`tile ${t!.eens.projected ? 'tile-bad' : ''}`}>
              <div className="tile-label">EENS</div>
              <div className="tile-value">{data.overall.every((o) => o.eens.asAt.compensation === null) ? 'Base data needed' : lkr(t!.eens.asAt)}</div>
              {!data.complete && <div className="tile-sub">Projected {lkr(t!.eens.projected)}</div>}
            </div>
            <div className={`tile ${t!.individual.projected ? 'tile-bad' : 'tile-good'}`}>
              <div className="tile-label">Individual ({data.individual.qualifyingAsAt} transformers {data.complete ? '' : 'so far'})</div>
              <div className="tile-value">{lkr(t!.individual.asAt)}</div>
              {!data.complete && <div className="tile-sub">Projected {lkr(t!.individual.projected)} - {data.individual.qualifyingProjected} transformers</div>}
            </div>
            <div className="tile">
              <div className="tile-label">Total {label.toLowerCase()}</div>
              <div className="tile-value">{lkr(t!.overall.asAt + t!.eens.asAt + t!.individual.asAt)}</div>
              {!data.complete && <div className="tile-sub">Projected {lkr(t!.overall.projected + t!.eens.projected + t!.individual.projected)}</div>}
            </div>
          </section>

          <section className="card">
            <h2>Overall supply quality compensation (section 12.1)</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>Feeder class</th>
                    <th colSpan={4} className="group">SAIDI (hours / consumer)</th>
                    <th colSpan={4} className="group">SAIFI (interruptions / consumer)</th>
                    <th rowSpan={2} className="num">Compensation {label.toLowerCase()}</th>
                    {!data.complete && <th rowSpan={2} className="num">Projected for {data.year}</th>}
                  </tr>
                  <tr>
                    <th className="num">Approved</th><th className="num">Actual</th><th className="num">Actual - approved</th><th className="num">C SAIDI</th>
                    <th className="num">Approved</th><th className="num">Actual</th><th className="num">Actual - approved</th><th className="num">C SAIFI</th>
                  </tr>
                </thead>
                <tbody>
                  {data.overall.map((o) => (
                    <tr key={o.feederClass}>
                      <td>FC{o.feederClass}</td>
                      <td className="num">{num(o.approvedSaidi)}</td>
                      <td className="num">{num(o.saidi)}</td>
                      <td className={`num ${(o.asAt?.saidiExcess ?? 0) > 0 ? 'text-bad' : ''}`}>{o.asAt ? num(o.asAt.saidiExcess) : '-'}</td>
                      <td className={`num ${o.asAt?.basis === 'SAIDI' ? 'strong' : ''}`}>{o.asAt ? lkr(o.asAt.cSaidi) : '-'}</td>
                      <td className="num">{num(o.approvedSaifi)}</td>
                      <td className="num">{num(o.saifi)}</td>
                      <td className={`num ${(o.asAt?.saifiExcess ?? 0) > 0 ? 'text-bad' : ''}`}>{o.asAt ? num(o.asAt.saifiExcess) : '-'}</td>
                      <td className={`num ${o.asAt?.basis === 'SAIFI' ? 'strong' : ''}`}>{o.asAt ? lkr(o.asAt.cSaifi) : '-'}</td>
                      <td className="num strong">{o.missing.length ? <span className="text-warn small">Missing: {o.missing.join(', ')}</span> : <>{lkr(o.asAt!.compensation)}{o.asAt!.basis && <div className="muted small">on {o.asAt!.basis}</div>}</>}</td>
                      {!data.complete && (
                        <td className="num">
                          {o.projected ? <>{lkr(o.projected.compensation)}<div className="muted small">SAIDI {num(o.projectedSaidi)} / SAIFI {num(o.projectedSaifi)}{o.projected.basis ? ` - on ${o.projected.basis}` : ''}</div></> : '-'}
                        </td>
                      )}
                    </tr>
                  ))}
                  <tr className="total-row">
                    <td colSpan={9}>Total</td>
                    <td className="num">{lkr(t!.overall.asAt)}</td>
                    {!data.complete && <td className="num">{lkr(t!.overall.projected)}</td>}
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="muted small">
              C SAIDI = (SAIDI - approved) x YearEnergy / 8760 x SUPPLYCOST; C SAIFI = (SAIFI - approved) x (SAIDI / SAIFI) x YearEnergy / 8760 x SUPPLYCOST; zero when below the approved level.
              Compensation = the larger of the two. LECO interruptions only (CEB-related excluded); SAIDI / SAIFI include momentary as in the report.
            </p>
          </section>

          <section className="card">
            <h2>EENS compensation (section 12.2)</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Feeder class</th><th className="num">Approved EENS (MWh)</th><th className="num">Actual EENS (MWh)</th><th className="num">Actual - approved (MWh)</th><th className="num">CENS (LKR/kWh)</th><th className="num">Compensation {label.toLowerCase()}</th>{!data.complete && <th className="num">Projected</th>}</tr></thead>
                <tbody>
                  {data.overall.map((o) => (
                    <tr key={o.feederClass}>
                      <td>FC{o.feederClass}</td>
                      <td className="num">{o.eens.approvedKwh === null ? '-' : num(o.eens.approvedKwh / 1000, 1)}</td>
                      <td className="num">{num(o.eens.actualKwh / 1000, 1)}</td>
                      <td className="num">{o.eens.asAt.excessKwh === null ? '-' : num(o.eens.asAt.excessKwh / 1000, 1)}</td>
                      <td className="num">{num(o.eens.cens)}</td>
                      <td className="num strong">{o.eens.asAt.compensation === null ? <span className="text-warn small">Approved EENS / CENS not set</span> : lkr(o.eens.asAt.compensation)}</td>
                      {!data.complete && <td className="num">{o.eens.projected.compensation === null ? '-' : lkr(o.eens.projected.compensation)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">C EENS = (EENS / ETOT - approved EENS / ETOT) x YearEnergy x CENS = (EENS - approved EENS) x CENS; zero when below. EENS comes from the optional "ens_kwh" figures in the interruption data.</p>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Individual supply quality compensation (section 12.3)</h2>
              {data.individual.rows.length > 0 && <button className="btn" onClick={() => csvExport(data)}>Export CSV for billing</button>}
            </div>
            <p className="muted small">
              Transformer customer groups whose annual LECO interruption duration exceeds the specified hours{data.complete ? '' : ' (already, or projected to by year end)'}. Group compensation = hours above the specified duration x group annual energy / 8760 x supply cost; it is paid to the group's customers in proportion to their annual energy use.
              {data.individual.estimatedEnergy > 0 && ` ${data.individual.estimatedEnergy} transformer(s) have no annual energy in the register - estimated from the feeder class energy per consumer (marked "est.").`}
            </p>
            {data.individual.rows.length === 0 ? (
              <p className="muted">No transformer {data.complete ? 'exceeded' : 'exceeds or is projected to exceed'} its specified annual interruption duration.</p>
            ) : (
              <div className="table-wrap">
                <table className="dense">
                  <thead>
                    <tr>
                      <th>TF ID</th><th>CSC</th><th className="num">FC</th><th className="num">Consumers</th><th className="num">Energy kWh/yr</th>
                      <th className="num">Duration (h)</th><th className="num">Specified (h)</th><th className="num">Exceeding (h)</th><th className="num">Compensation {label.toLowerCase()}</th>
                      {!data.complete && <><th className="num">Projected (h)</th><th className="num">Projected compensation</th></>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.individual.rows.map((r) => (
                      <tr key={r.transformerId}>
                        <td className="mono">{r.code}</td>
                        <td>{r.csc}</td>
                        <td className="num">{r.feederClass}</td>
                        <td className="num">{r.consumers}</td>
                        <td className="num">{num(r.energyKwh, 0)}{r.energyEstimated && <span className="muted small"> est.</span>}</td>
                        <td className="num">{num(r.durationHours, 1)}</td>
                        <td className="num">{r.specifiedHours}</td>
                        <td className={`num ${r.asAt.exceedingHours > 0 ? 'text-bad' : ''}`}>{num(r.asAt.exceedingHours, 1)}</td>
                        <td className="num strong">{lkr(r.asAt.compensation)}</td>
                        {!data.complete && <><td className="num">{num(r.projectedHours, 1)}</td><td className="num">{lkr(r.projected.compensation)}</td></>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
