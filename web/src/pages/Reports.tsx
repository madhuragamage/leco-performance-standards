import { useEffect, useState } from 'react';
import { api, download } from '../api';
import { CscSelect, Empty, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { fmtLkr, fmtUnit, monthStartKey, todayKey } from '../format';
import type { Unit } from '../types';

type Tab = 'liss' | 'penalties' | 'kpi';

function MonthPicker({ year, month, onChange }: { year: number; month: number; onChange: (y: number, m: number) => void }) {
  return (
    <input type="month" value={`${year}-${String(month).padStart(2, '0')}`} onChange={(e) => e.target.value && onChange(Number(e.target.value.slice(0, 4)), Number(e.target.value.slice(5, 7)))} />
  );
}

function Lis() {
  const [list, setList] = useState<{ code: string; title: string }[]>([]);
  const [code, setCode] = useState('R1');
  const now = todayKey();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [data, setData] = useState<{ title: string; header: string[]; rows: (string | number)[][] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ code: string; title: string }[]>('/monitoring/reports/liss').then(setList).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setData(null);
    api<{ title: string; header: string[]; rows: (string | number)[][] }>(`/monitoring/reports/liss/${code}?year=${year}&month=${month}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [code, year, month]);

  return (
    <>
      <div className="filters bar">
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          {list.map((l) => <option key={l.code} value={l.code}>{l.code} - {l.title}</option>)}
        </select>
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        <button className="btn primary" onClick={() => download(`/monitoring/reports/liss/${code}?year=${year}&month=${month}&format=csv`, `LISS-${code}-${year}-${String(month).padStart(2, '0')}.csv`).catch((e) => setError(e.message))}>
          Download CSV for PUCSL
        </button>
      </div>
      <ErrorBox error={error} />
      <p className="muted small">Rows are measures whose clock stopped in the selected month. R8 (other complaints) is "to be introduced later" by PUCSL.</p>
      {data && data.rows.length === 0 && <Empty>No records for this month.</Empty>}
      {data && data.rows.length > 0 && (
        <div className="card flush">
          <div className="table-wrap">
            <table className="dense">
              <thead><tr>{data.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{data.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

function Penalties() {
  const now = todayKey();
  const [year, setYear] = useState(Number(now.slice(0, 4)));
  const [month, setMonth] = useState(Number(now.slice(5, 7)));
  const [data, setData] = useState<{ header: string[]; rows: (string | number)[][]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<{ header: string[]; rows: (string | number)[][]; total: number }>(`/monitoring/reports/penalties?year=${year}&month=${month}`).then(setData).catch((e) => setError(e.message));
  }, [year, month]);
  return (
    <>
      <div className="filters bar">
        <MonthPicker year={year} month={month} onChange={(y, m) => { setYear(y); setMonth(m); }} />
        <button className="btn" onClick={() => download(`/monitoring/reports/penalties?year=${year}&month=${month}&format=csv`, `compensation-${year}-${month}.csv`).catch((e) => setError(e.message))}>
          Download CSV
        </button>
        {data && <strong>Total payable: {fmtLkr(data.total)}</strong>}
      </div>
      <ErrorBox error={error} />
      {data && data.rows.length === 0 && <Empty>No compensation payable for this month.</Empty>}
      {data && data.rows.length > 0 && (
        <div className="card flush">
          <div className="table-wrap">
            <table className="dense">
              <thead><tr>{data.header.map((h) => <th key={h}>{h}</th>)}</tr></thead>
              <tbody>{data.rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}

interface KpiData {
  service: { name: string; kpiPrefix: string; unit: Unit };
  requests: number;
  kpis: { code: string; label: string; remarks?: string; count: number; avg: number | null; max: number | null }[];
  byCsc: { csc: string; values: Record<string, number | null> }[];
}

function Kpis() {
  const { meta } = useApp();
  const [serviceType, setServiceType] = useState(meta.services[0].code);
  const [from, setFrom] = useState(monthStartKey());
  const [to, setTo] = useState(todayKey());
  const [cscId, setCscId] = useState<number | ''>('');
  const [data, setData] = useState<KpiData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const p = new URLSearchParams({ serviceType, from, to, ...(cscId ? { cscId: String(cscId) } : {}) });
    api<KpiData>(`/monitoring/kpi?${p}`).then(setData).catch((e) => setError(e.message));
  }, [serviceType, from, to, cscId]);
  const shown = data?.kpis.filter((k) => k.count > 0) ?? [];
  return (
    <>
      <div className="filters bar">
        <select value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
          {meta.services.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <CscSelect value={cscId} onChange={setCscId} />
      </div>
      <ErrorBox error={error} />
      {data && (
        <>
          <p className="muted small">{data.requests} requests received in the period. Values in {data.service.unit.replace('_', ' ').toLowerCase()}.</p>
          <div className="card flush">
            <div className="table-wrap">
              <table>
                <thead><tr><th>KPI</th><th>Performance segment</th><th className="num">Samples</th><th className="num">Average</th><th className="num">Worst</th></tr></thead>
                <tbody>
                  {data.kpis.map((k) => (
                    <tr key={k.code}>
                      <td className="mono small">{k.code}</td>
                      <td>{k.label}{k.remarks && <div className="muted small">{k.remarks}</div>}</td>
                      <td className="num">{k.count}</td>
                      <td className="num">{fmtUnit(k.avg, data.service.unit)}</td>
                      <td className="num">{fmtUnit(k.max, data.service.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          {data.byCsc.length > 0 && shown.length > 0 && (
            <div className="card flush">
              <h2 className="pad">Average by CSC</h2>
              <div className="table-wrap">
                <table className="dense">
                  <thead><tr><th>CSC</th>{shown.map((k) => <th key={k.code} className="num" title={k.label}>{k.code.split('-').slice(1).join('-')}</th>)}</tr></thead>
                  <tbody>
                    {data.byCsc.sort((a, b) => a.csc.localeCompare(b.csc)).map((r) => (
                      <tr key={r.csc}>
                        <td>{r.csc}</td>
                        {shown.map((k) => <td key={k.code} className="num">{r.values[k.code] === null ? '-' : r.values[k.code]}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

export function ReportsPage() {
  const [tab, setTab] = useState<Tab>('liss');
  return (
    <>
      <PageHead title="Reports" sub="PUCSL LISS submissions, compensation register and process KPIs" />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'liss'} className={tab === 'liss' ? 'on' : ''} onClick={() => setTab('liss')}>LISS formats (R1-R7)</button>
        <button role="tab" aria-selected={tab === 'penalties'} className={tab === 'penalties' ? 'on' : ''} onClick={() => setTab('penalties')}>Compensation register</button>
        <button role="tab" aria-selected={tab === 'kpi'} className={tab === 'kpi' ? 'on' : ''} onClick={() => setTab('kpi')}>KPI analysis</button>
      </div>
      {tab === 'liss' && <Lis />}
      {tab === 'penalties' && <Penalties />}
      {tab === 'kpi' && <Kpis />}
    </>
  );
}
