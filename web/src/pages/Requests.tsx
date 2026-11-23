import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { ComplianceBadge, CscSelect, Empty, ErrorBox, PageHead, StatusBadge } from '../components';
import { useApp } from '../context';
import { fmtDateTime } from '../format';
import { lodgeableServices } from './NewRequest';
import type { Compliance } from '../types';

interface Row {
  id: number;
  refNo: string;
  portalReference: string | null;
  serviceType: string;
  serviceName: string;
  subType: string | null;
  source: string;
  customerName: string;
  accountNo: string | null;
  csc: { name: string; feederClass: number };
  status: 'OPEN' | 'COMPLETED' | 'CANCELLED';
  currentStepLabel: string | null;
  compliance: Compliance;
  createdAt: string;
  assignedTo: { id: number; fullName: string } | null;
}

export function RequestsPage() {
  const { meta, user } = useApp();
  const nav = useNavigate();
  const [serviceType, setServiceType] = useState('');
  const [status, setStatus] = useState('OPEN');
  const [cscId, setCscId] = useState<number | ''>('');
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ total: number; rows: Row[]; pageSize: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => setPage(1), [serviceType, status, cscId, debounced]);

  useEffect(() => {
    const p = new URLSearchParams({ page: String(page), pageSize: '50' });
    if (serviceType) p.set('serviceType', serviceType);
    if (status) p.set('status', status);
    if (cscId) p.set('cscId', String(cscId));
    if (debounced) p.set('q', debounced);
    api<{ total: number; rows: Row[]; pageSize: number }>(`/requests?${p}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [serviceType, status, cscId, debounced, page]);

  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <>
      <PageHead
        title="Service requests"
        sub={data ? `${data.total} requests` : 'Loading...'}
        actions={lodgeableServices(meta.services, user.role).length > 0 && <Link className="btn primary" to="/requests/new">New request</Link>}
      />
      <div className="filters bar">
        <select value={serviceType} onChange={(e) => setServiceType(e.target.value)}>
          <option value="">All services</option>
          {meta.services.map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          <option value="OPEN">Open</option>
          <option value="COMPLETED">Completed</option>
          <option value="CANCELLED">Cancelled</option>
        </select>
        <CscSelect value={cscId} onChange={setCscId} />
        <input type="search" placeholder="Ref no, portal ref, customer, account, mobile" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBox error={error} />
      {data && data.rows.length === 0 ? (
        <Empty>No requests found.</Empty>
      ) : (
        <div className="card flush">
          <div className="table-wrap">
            <table className="clickable">
              <thead>
                <tr><th>Ref no</th><th>Service</th><th>CSC</th><th>Customer</th><th>Source</th><th>Received</th><th>Current step</th><th>Assigned to</th><th>Status</th><th>SLA</th></tr>
              </thead>
              <tbody>
                {data?.rows.map((r) => (
                  <tr key={r.id} onClick={() => nav(`/requests/${r.id}`)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && nav(`/requests/${r.id}`)}>
                    <td className="mono">{r.refNo}{r.portalReference && <div className="muted small">{r.portalReference}</div>}</td>
                    <td>{r.serviceName}</td>
                    <td>{r.csc.name}</td>
                    <td>{r.customerName}{r.accountNo && <div className="muted small">A/C {r.accountNo}</div>}</td>
                    <td>{r.source.replace('_', ' ').toLowerCase()}</td>
                    <td>{fmtDateTime(r.createdAt)}</td>
                    <td>{r.currentStepLabel}</td>
                    <td>{r.assignedTo ? (r.assignedTo.id === user.id ? <strong>You</strong> : r.assignedTo.fullName) : <span className="muted">-</span>}</td>
                    <td><StatusBadge s={r.status} /></td>
                    <td>{r.status !== 'CANCELLED' && <ComplianceBadge c={r.compliance} />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {pages > 1 && (
        <div className="pager">
          <button className="btn" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</button>
          <span className="muted">Page {page} of {pages}</span>
          <button className="btn" disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
