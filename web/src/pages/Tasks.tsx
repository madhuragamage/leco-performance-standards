import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { Empty, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import type { Priority, TaskRow, TaskSummary } from '../types';

export const PRIORITY_LABEL: Record<Priority, string> = {
  BREACHED: 'Regulatory breach',
  REG_DUE_SOON: 'Regulatory due soon',
  OVERDUE: 'LECO target exceeded',
  DUE_SOON: 'Due soon',
  ON_TRACK: 'On track',
  NO_DEADLINE: 'No deadline',
  AWAITING_CUSTOMER: 'Awaiting customer',
};

type Filter = 'all' | 'mine' | 'queue' | 'urgent' | 'waiting';

export function TasksPage({ onChanged }: { onChanged?: () => void }) {
  const { user, meta } = useApp();
  const nav = useNavigate();
  const [data, setData] = useState<{ rows: TaskRow[]; summary: TaskSummary } | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api<{ rows: TaskRow[]; summary: TaskSummary }>('/tasks')
      .then((d) => {
        setData(d);
        onChanged?.();
      })
      .catch((e) => setError(e.message));
  }, [onChanged]);
  useEffect(load, [load]);

  async function take(t: TaskRow) {
    setBusy(t.requestId);
    try {
      await api(`/requests/${t.requestId}/assign`, { method: 'POST', body: { userId: user.id } });
      load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const rows = (data?.rows ?? []).filter((r) =>
    filter === 'mine' ? r.bucket === 'MINE' : filter === 'queue' ? r.bucket === 'QUEUE' : filter === 'urgent' ? r.urgent && r.bucket !== 'MINE_WAITING' : filter === 'waiting' ? r.bucket === 'MINE_WAITING' : true,
  );
  const count = (f: Filter) =>
    (data?.rows ?? []).filter((r) => (f === 'mine' ? r.bucket === 'MINE' : f === 'queue' ? r.bucket === 'QUEUE' : f === 'urgent' ? r.urgent && r.bucket !== 'MINE_WAITING' : f === 'waiting' ? r.bucket === 'MINE_WAITING' : true)).length;
  const roleLabel = (codes: string[]) => codes.map((c) => meta.roles.find((r) => r.code === c)?.label ?? c).join(' / ');

  return (
    <>
      <PageHead
        title="My tasks"
        sub={data ? `${data.summary.actionable} to act on - ${data.summary.urgent} urgent${data.summary.breached ? `, ${data.summary.breached} past the regulatory target` : ''}` : 'Loading...'}
        actions={<button className="btn" onClick={load}>Refresh</button>}
      />
      {data && data.summary.urgent > 0 && (
        <div className="urgent-banner" role="alert">
          <strong>{data.summary.urgent} urgent action{data.summary.urgent > 1 ? 's' : ''}.</strong> Items in red are past or about to pass the regulatory target; amber items have passed or are about to pass the LECO target.
        </div>
      )}
      <div className="tabs" role="tablist">
        {(
          [
            ['all', 'All'],
            ['urgent', 'Urgent'],
            ['mine', 'Assigned to me'],
            ['queue', 'Team queue'],
            ['waiting', 'Mine - waiting on others'],
          ] as [Filter, string][]
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={filter === k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>
            {l} <span className="count">{count(k)}</span>
          </button>
        ))}
      </div>
      <ErrorBox error={error} />
      {data && rows.length === 0 ? (
        <Empty>{filter === 'all' ? 'Nothing waiting for you. ' : 'Nothing here. '}Requests assigned to you, and open requests whose next step is for your role, appear here.</Empty>
      ) : (
        <div className="task-list">
          {rows.map((t, i) => (
            <div
              key={t.requestId}
              className={`task task-${t.priority.toLowerCase()} ${t.bucket === 'MINE_WAITING' ? 'task-waiting' : ''}`}
              onClick={() => nav(`/requests/${t.requestId}`)}
              onKeyDown={(e) => e.key === 'Enter' && nav(`/requests/${t.requestId}`)}
              tabIndex={0}
              role="link"
              aria-label={`${t.refNo}: ${PRIORITY_LABEL[t.priority]}`}
            >
              <div className="task-rank">{i + 1}</div>
              <div className="task-main">
                <div className="task-top">
                  <span className={`badge prio-${t.priority.toLowerCase()}`}>{PRIORITY_LABEL[t.priority]}</span>
                  <span className="mono">{t.refNo}</span>
                  <span className="muted small">{t.serviceName}</span>
                </div>
                <div className="task-what">
                  {t.bucket === 'MINE_WAITING' ? 'Waiting for: ' : 'Next: '}
                  <strong>{t.nextActions.map((a) => a.label).join(' / ') || '-'}</strong>
                  {t.bucket === 'MINE_WAITING' && t.nextActions[0] && <span className="muted small"> (by {roleLabel(t.nextActions[0].roles)})</span>}
                </div>
                <div className="muted small">
                  {t.customerName} - {t.cscName}
                  {t.clockLabel && ` - ${t.clockLabel}`}
                </div>
              </div>
              <div className="task-side">
                <div className={`task-reason ${t.urgent ? 'strong' : ''}`}>{t.reason}</div>
                <div className="small muted">
                  {t.bucket === 'QUEUE' ? (t.assignedTo ? `Assigned to ${t.assignedTo.fullName}` : 'Unassigned') : 'Assigned to you'}
                </div>
                {t.bucket === 'QUEUE' && (
                  <button
                    className="btn small-btn"
                    disabled={busy === t.requestId}
                    onClick={(e) => {
                      e.stopPropagation();
                      void take(t);
                    }}
                  >
                    Take it
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
