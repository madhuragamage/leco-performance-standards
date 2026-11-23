import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorBox, PageHead } from '../components';
import { fmtDateTime, todayKey } from '../format';

interface Result {
  ok: boolean;
  imported: boolean;
  summary: Record<string, unknown> & { rows: number; valid: number };
  warnings?: string[];
  errors: { line: number; message: string }[];
  errorCount: number;
  layout?: 'LONG' | 'WIDE' | null;
}
interface Upload { id: number; kind: string; source: string; filename: string | null; uploadedAt: string; rows: number; periodFrom: string | null; periodTo: string | null; uploadedBy: string | null; summary: { removedAt?: string; removedRecords?: number } | null }

const CATS = ['11-LECO-F', '11-LECO-P', '11-LECO-M', 'LV-LECO-F', 'LV-LECO-P', '33-CEB-F', '33-CEB-P', '11-CEB-F', '11-CEB-P'];

function saveText(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const TEMPLATES = {
  transformers: () => saveText('transformer-register-template.csv', 'tf_id,csc,consumers,name,annual_energy_kwh\nBZ0001,MRN,225,Rawatawatte Rd,270000\nBZ0002,Moratuwa North,145,,\n'),
  long: () =>
    saveText(
      'interruptions-template.csv',
      `date,tf_id,category,consumer_hours,consumer_interruptions,ens_kwh,consumers\n${todayKey()},BZ0001,11-LECO-F,450.5,225,270,225\n${todayKey()},BZ0001,33-CEB-P,900,225,540,225\n`,
    ),
  wide: () =>
    saveText(
      'interruptions-wide-template.csv',
      `date,tf_id,consumers,${CATS.flatMap((c) => [`${c}-Cons.hrs`, `${c}-Cons.Interruptions`, `${c}-ENS.kWh`]).join(',')}\n${todayKey()},BZ0001,225,450.5,225,270,${CATS.slice(1).map(() => '0,0,0').join(',')}\n`,
    ),
};

function UploadCard({ kind, onImported }: { kind: 'transformers' | 'interruptions'; onImported: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [dateFormat, setDateFormat] = useState('AUTO');
  const [month, setMonth] = useState(todayKey().slice(0, 7));
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(dryRun: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const body = kind === 'transformers' ? { csv: file.text, filename: file.name, month, dryRun } : { csv: file.text, filename: file.name, dateFormat, dryRun };
      const r = await api<Result>(`/supply/uploads/${kind}`, { method: 'POST', body });
      setResult(r);
      if (r.imported) {
        setFile(null);
        onImported();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const s = result?.summary as Record<string, unknown> | undefined;
  return (
    <section className="card upload-card">
      <h2>{kind === 'transformers' ? '1. Transformer register' : '2. Interruption data'}</h2>
      <p className="muted small">
        {kind === 'transformers'
          ? 'Each transformer with its CSC (code or name) and number of consumers; the CSC decides the feeder class. Optional annual_energy_kwh (energy sales to its customers) is used for individual compensation - if missing it is estimated. Upload whenever transformers or consumer numbers change; counts are kept per month for "average consumers".'
          : 'Transformer-wise consumer hours lost and consumer interruptions per category, by date - daily or for any interval, with optional energy not supplied (ens_kwh) for EENS. Uploading the same date / transformer / category again replaces the earlier figure. ADMS can also push this through the API.'}
      </p>
      <div className="filters">
        {kind === 'transformers' ? (
          <button className="link" onClick={TEMPLATES.transformers}>Download template</button>
        ) : (
          <>
            <button className="link" onClick={TEMPLATES.long}>Template (one row per category)</button>
            <button className="link" onClick={TEMPLATES.wide}>Template (one column per category)</button>
          </>
        )}
      </div>
      <div className="upload-row">
        <label>
          CSV file
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              setResult(null);
              if (!f) return setFile(null);
              f.text().then((text) => setFile({ name: f.name, text }));
            }}
          />
        </label>
        {kind === 'transformers' ? (
          <label>
            Consumer numbers as at
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
        ) : (
          <label>
            Date format in file
            <select value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
              <option value="AUTO">YYYY-MM-DD (or unambiguous)</option>
              <option value="DMY">DD/MM/YYYY</option>
              <option value="MDY">MM/DD/YYYY</option>
            </select>
          </label>
        )}
        <button className="btn" disabled={!file || busy} onClick={() => send(true)}>{busy ? 'Checking...' : 'Check file'}</button>
        <button className="btn primary" disabled={!file || busy || !result?.ok || result.imported} onClick={() => send(false)}>Import</button>
      </div>
      <p className="muted small">Excel: File → Save As → CSV (UTF-8). Nothing is saved until you press Import after a successful check.</p>
      <ErrorBox error={error} />
      {result && (
        <div className={result.imported ? 'ok-box' : result.ok ? 'notice' : 'error-box'}>
          {result.imported ? 'Imported. ' : result.ok ? 'File checked - ready to import. ' : `${result.errorCount} problem(s) found - nothing imported. `}
          {kind === 'transformers' && s && (
            <>
              {String(s.valid)} transformers: {String(s.new)} new, {String(s.updated)} changed, {String(s.unchanged)} unchanged - {Number(s.consumers).toLocaleString('en-US')} consumers ({String(s.month)}).
            </>
          )}
          {kind === 'interruptions' && s && (
            <>
              {String(s.valid)} rows ({result.layout === 'WIDE' ? 'one column per category' : 'one row per category'}) for {String(s.transformers)} transformers, {String(s.periodFrom ?? '-')} to {String(s.periodTo ?? '-')}
              {Number(s.replaces) > 0 && <>; replaces {String(s.replaces)} existing figure(s)</>}.
            </>
          )}
        </div>
      )}
      {result?.warnings && result.warnings.length > 0 && (
        <ul className="small warn-list">{result.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
      )}
      {kind === 'interruptions' && s && Array.isArray(s.totals) && result?.ok && (
        <table className="dense">
          <thead><tr><th>Category</th><th className="num">Consumer hours</th><th className="num">Consumer interruptions</th></tr></thead>
          <tbody>
            {(s.totals as { category: string; label: string; hours: number; interruptions: number }[])
              .filter((t) => t.hours || t.interruptions)
              .map((t) => (
                <tr key={t.category}><td>{t.label}</td><td className="num">{t.hours.toLocaleString('en-US')}</td><td className="num">{t.interruptions.toLocaleString('en-US')}</td></tr>
              ))}
          </tbody>
        </table>
      )}
      {result && result.errors.length > 0 && (
        <div className="table-wrap errors-table">
          <table className="dense">
            <thead><tr><th className="num">Line</th><th>Problem</th></tr></thead>
            <tbody>{result.errors.map((e, i) => <tr key={i}><td className="num">{e.line}</td><td>{e.message}</td></tr>)}</tbody>
          </table>
          {result.errorCount > result.errors.length && <p className="muted small">Showing the first {result.errors.length} of {result.errorCount}.</p>}
        </div>
      )}
    </section>
  );
}

export function SupplyUploadPage() {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [tfs, setTfs] = useState<{ total: number; consumers: number; rows: { id: number; code: string; name: string | null; csc: string; feederClass: number; consumers: number; active: boolean }[] } | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Upload[]>('/supply/uploads').then(setUploads).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);
  useEffect(() => {
    const t = setTimeout(() => api<typeof tfs>(`/supply/transformers?q=${encodeURIComponent(q)}`).then(setTfs).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [q, uploads.length]);

  async function remove(u: Upload) {
    if (!confirm(`Remove the interruption figures loaded by this upload (${u.rows} rows, ${u.periodFrom} to ${u.periodTo})?`)) return;
    try {
      await api(`/supply/uploads/${u.id}`, { method: 'DELETE' });
      load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHead title="Supply quality data" sub="Load the transformer register and transformer-wise interruption data" />
      <div className="grid-2">
        <UploadCard kind="transformers" onImported={load} />
        <UploadCard kind="interruptions" onImported={load} />
      </div>
      <ErrorBox error={error} />
      <section className="card">
        <h2>Upload history</h2>
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>When</th><th>Type</th><th>File / source</th><th>By</th><th className="num">Rows</th><th>Period</th><th /></tr></thead>
            <tbody>
              {uploads.length === 0 && <tr><td colSpan={7} className="muted">No uploads yet.</td></tr>}
              {uploads.map((u) => (
                <tr key={u.id} className={u.summary?.removedAt ? 'muted' : ''}>
                  <td>{fmtDateTime(u.uploadedAt)}</td>
                  <td>{u.kind === 'TRANSFORMERS' ? 'Transformer register' : 'Interruptions'}</td>
                  <td>{u.filename ?? '-'} <span className="muted small">({u.source === 'API' ? 'API' : 'web'})</span></td>
                  <td>{u.uploadedBy ?? '-'}</td>
                  <td className="num">{u.rows}</td>
                  <td>{u.periodFrom === u.periodTo ? u.periodFrom : `${u.periodFrom} to ${u.periodTo}`}</td>
                  <td>
                    {u.summary?.removedAt ? (
                      <span className="small">removed ({u.summary.removedRecords})</span>
                    ) : (
                      u.kind === 'INTERRUPTIONS' && <button className="link danger-link small" onClick={() => remove(u)}>Remove</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Transformer register</h2>
          {tfs && <span className="muted small">{tfs.total.toLocaleString('en-US')} transformers - {tfs.consumers.toLocaleString('en-US')} consumers (active)</span>}
        </div>
        <input type="search" placeholder="Search TF ID or name" value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="table-wrap">
          <table className="dense">
            <thead><tr><th>TF ID</th><th>Name</th><th>CSC</th><th className="num">FC</th><th className="num">Consumers</th><th>Active</th></tr></thead>
            <tbody>
              {tfs?.rows.map((t) => (
                <tr key={t.id}><td className="mono">{t.code}</td><td>{t.name ?? '-'}</td><td>{t.csc}</td><td className="num">{t.feederClass}</td><td className="num">{t.consumers}</td><td>{t.active ? 'Yes' : 'No'}</td></tr>
              ))}
            </tbody>
          </table>
          {tfs && tfs.total > tfs.rows.length && <p className="muted small">Showing {tfs.rows.length} of {tfs.total} - search to narrow down.</p>}
        </div>
      </section>
    </>
  );
}
