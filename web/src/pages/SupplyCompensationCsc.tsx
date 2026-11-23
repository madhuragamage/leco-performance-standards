import { Fragment, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorBox, PageHead } from '../components';
import { todayKey } from '../format';
import { ShareBar, lkr } from './CommercialCompensation';

interface Part { overall: number; eens: number; basis: string | null; excess: number; individual: number; individualCount: number; total: number }
interface Row {
  cscId: number; csc: string; branch: string; feederClass: number; avgConsumers: number;
  saidi: number; saifi: number; approvedSaidi: number | null; approvedSaifi: number | null; ensKwh: number;
  asAt: Part; projected: Part;
}
interface Data {
  year: number; from: string; to: string; complete: boolean; factor: number; partial: boolean;
  companyTotals: { overall: { asAt: number; projected: number }; eens: { asAt: number; projected: number }; individual: { asAt: number; projected: number } };
  feederClasses: { feederClass: number; asAt: { compensation: number; basis: string | null } | null; projected: { compensation: number; basis: string | null } | null; missing: string[] }[];
  rows: Row[];
}

const n2 = (n: number | null) => (n === null ? '-' : n.toFixed(2));

export function SupplyCompensationCscPage() {
  const thisYear = Number(todayKey().slice(0, 4));
  const [year, setYear] = useState(thisYear);
  const [view, setView] = useState<'asAt' | 'projected'>('projected');
  const [data, setData] = useState<Data | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api<Data>(`/supply/compensation/by-csc?year=${year}`).then(setData).catch((e) => setError(e.message));
  }, [year]);

  const sc = data?.complete ? 'asAt' : view;
  const rows = data ? [...data.rows].sort((a, b) => b[sc].total - a[sc].total) : [];
  const shown = rows.reduce((s, r) => s + r[sc].total, 0);
  const company = data ? data.companyTotals.overall[sc] + data.companyTotals.eens[sc] + data.companyTotals.individual[sc] : 0;
  const contributing = rows.filter((r) => r[sc].total > 0);

  return (
    <>
      <PageHead
        title="Supply quality compensation by CSC"
        sub="Each CSC's contribution to the overall (SAIDI / SAIFI), EENS and individual supply quality compensation (report section 12)"
        actions={
          <div className="filters">
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="Year">
              {Array.from({ length: 5 }, (_, i) => thisYear - i).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            {data && !data.complete && (
              <div className="seg" role="radiogroup" aria-label="Figures">
                <button className={view === 'asAt' ? 'on' : ''} onClick={() => setView('asAt')}>As at today</button>
                <button className={view === 'projected' ? 'on' : ''} onClick={() => setView('projected')}>Projected {year}</button>
              </div>
            )}
            <Link className="btn" to="/supply/compensation">Feeder class figures</Link>
          </div>
        }
      />
      <ErrorBox error={error} />
      {!data ? (
        !error && <div className="muted">Calculating...</div>
      ) : (
        <>
          <p className="muted small">
            {data.from} to {data.to}. {data.complete ? 'Final figures for the year.' : sc === 'asAt' ? 'As at today: indices so far.' : `Projected: indices annualised (x ${data.factor}) to the full year.`}
            {data.partial && ' You are seeing your own CSCs; the company total is shown for comparison.'}
          </p>
          <section className="tiles">
            <div className={`tile ${company ? 'tile-bad' : 'tile-good'}`}>
              <div className="tile-label">Company total</div>
              <div className="tile-value">{lkr(company)}</div>
              <div className="tile-sub">Overall {lkr(data.companyTotals.overall[sc])} - EENS {lkr(data.companyTotals.eens[sc])} - individual {lkr(data.companyTotals.individual[sc])}</div>
            </div>
            <div className="tile">
              <div className="tile-label">CSCs contributing</div>
              <div className="tile-value">{contributing.length} <span className="tile-sub">of {rows.length}</span></div>
              <div className="tile-sub">{rows.length - contributing.length} within the approved levels</div>
            </div>
            {contributing[0] && (
              <div className="tile tile-warn">
                <div className="tile-label">Largest contributor</div>
                <div className="tile-value">{contributing[0].csc}</div>
                <div className="tile-sub">{lkr(contributing[0][sc].total)} ({company ? ((contributing[0][sc].total / company) * 100).toFixed(1) : 0}%)</div>
              </div>
            )}
          </section>
          {data.feederClasses.some((f) => f.missing.length) && (
            <div className="notice">Some feeder classes have no base data ({data.feederClasses.filter((f) => f.missing.length).map((f) => `FC${f.feederClass}: ${f.missing.join(', ')}`).join('; ')}). Enter it on the Compensation page.</div>
          )}
          {rows.length === 0 ? (
            <Empty>No CSCs.</Empty>
          ) : (
            <section className="card flush">
              <div className="table-wrap">
                <table className="clickable">
                  <thead>
                    <tr>
                      <th className="num">#</th><th>CSC</th><th className="num">FC</th>
                      <th className="num">SAIDI / approved</th><th className="num">SAIFI / approved</th>
                      <th className="num">Overall (12.1)</th><th className="num">EENS (12.2)</th><th className="num">Individual (12.3)</th>
                      <th className="num">Total</th><th>Share of company total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => {
                      const p = r[sc];
                      const f = sc === 'projected' ? data.factor : 1;
                      const saidiOver = r.approvedSaidi !== null && r.saidi * f > r.approvedSaidi;
                      const saifiOver = r.approvedSaifi !== null && r.saifi * f > r.approvedSaifi;
                      return (
                        <Fragment key={r.cscId}>
                          <tr onClick={() => setOpen(open === r.cscId ? null : r.cscId)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === r.cscId ? null : r.cscId)} aria-expanded={open === r.cscId} className={p.total ? '' : 'muted'}>
                            <td className="num">{i + 1}</td>
                            <td>{r.csc}<div className="muted small">{r.branch}</div></td>
                            <td className="num">{r.feederClass}</td>
                            <td className={`num ${saidiOver ? 'text-bad' : ''}`}>{n2(r.saidi * f)} / {n2(r.approvedSaidi)}</td>
                            <td className={`num ${saifiOver ? 'text-bad' : ''}`}>{n2(r.saifi * f)} / {n2(r.approvedSaifi)}</td>
                            <td className="num">{p.overall ? <>{lkr(p.overall)}<div className="muted small">on {p.basis}</div></> : '-'}</td>
                            <td className="num">{p.eens ? lkr(p.eens) : '-'}</td>
                            <td className="num">{p.individual ? <>{lkr(p.individual)}<div className="muted small">{p.individualCount} transformer(s)</div></> : '-'}</td>
                            <td className="num strong">{p.total ? lkr(p.total) : '-'}</td>
                            <td><ShareBar pct={company ? (p.total / company) * 100 : null} /></td>
                          </tr>
                          {open === r.cscId && (
                            <tr className="detail-row">
                              <td colSpan={10}>
                                <div className="explain">
                                  <p>
                                    <strong>{r.csc}</strong> - average consumers {r.avgConsumers.toLocaleString('en-US')}; LECO SAIDI {n2(r.saidi * f)} h (approved {n2(r.approvedSaidi)}), SAIFI {n2(r.saifi * f)} (approved {n2(r.approvedSaifi)})
                                    {sc === 'projected' && !data.complete ? ', annualised' : ''}.
                                  </p>
                                  {p.overall > 0 ? (
                                    <p>
                                      Feeder class {r.feederClass} compensation is decided on <strong>{p.basis}</strong>. This CSC is{' '}
                                      {p.basis === 'SAIDI' ? `${p.excess.toLocaleString('en-US')} consumer hours` : `${p.excess.toLocaleString('en-US')} consumer interruptions`} above what the approved {p.basis} allows for its consumers, so it carries that share of the
                                      feeder class amount: {lkr(p.overall)}.
                                    </p>
                                  ) : (
                                    <p>No share of the feeder class overall compensation: {saidiOver || saifiOver ? 'the deciding index for its feeder class is within the approved level for this CSC.' : 'its SAIDI and SAIFI are within the approved levels.'}</p>
                                  )}
                                  {p.eens > 0 && <p>EENS: {r.ensKwh.toLocaleString('en-US')} kWh not supplied, above its consumer-weighted part of the approved EENS → {lkr(p.eens)}.</p>}
                                  {p.individual > 0 && (
                                    <p>
                                      Individual: {p.individualCount} transformer group(s) exceed the specified annual interruption duration → {lkr(p.individual)}. <Link to="/supply/compensation">See transformers</Link>
                                    </p>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                    <tr className="total-row">
                      <td colSpan={5}>{data.partial ? 'Total of your CSCs' : 'Total'}</td>
                      <td className="num">{lkr(rows.reduce((s, r) => s + r[sc].overall, 0))}</td>
                      <td className="num">{lkr(rows.reduce((s, r) => s + r[sc].eens, 0))}</td>
                      <td className="num">{lkr(rows.reduce((s, r) => s + r[sc].individual, 0))}</td>
                      <td className="num">{lkr(shown)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              </div>
            </section>
          )}
          <p className="muted small">
            How the shares are worked out: the overall compensation of a feeder class is shared among its CSCs by how far each is above the approved level on the deciding index (consumer hours above the SAIDI allowance, or consumer interruptions above the SAIFI allowance);
            CSCs within the approved level carry no share. EENS is shared by each CSC's energy not supplied above its consumer-weighted part of the approved EENS. Individual compensation belongs to the CSC of each transformer. Click a CSC for the explanation.
          </p>
        </>
      )}
    </>
  );
}
