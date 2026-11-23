import { type ReactNode, useEffect } from 'react';
import { complianceLabel } from './format';
import type { Compliance, Csc } from './types';
import { useApp } from './context';

export function ComplianceBadge({ c, paused }: { c: Compliance; paused?: boolean }) {
  return (
    <span className="badges">
      <span className={`badge badge-${c.toLowerCase()}`}>{complianceLabel[c]}</span>
      {paused && <span className="badge badge-paused">Awaiting customer</span>}
    </span>
  );
}

export function StatusBadge({ s }: { s: string }) {
  return <span className={`badge badge-status-${s.toLowerCase()}`}>{s.charAt(0) + s.slice(1).toLowerCase()}</span>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="error-box">{error}</div>;
}

export function PageHead({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <div className="muted">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function CscSelect({ value, onChange, allowAll = true, branchId }: { value: number | ''; onChange: (v: number | '') => void; allowAll?: boolean; branchId?: number | '' }) {
  const { meta } = useApp();
  const byBranch = new Map<string, Csc[]>();
  for (const c of meta.cscs) {
    if (branchId && c.branchId !== branchId) continue;
    if (!byBranch.has(c.branchName)) byBranch.set(c.branchName, []);
    byBranch.get(c.branchName)!.push(c);
  }
  return (
    <select value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')}>
      {allowAll && <option value="">All CSCs</option>}
      {[...byBranch.entries()].map(([b, cs]) => (
        <optgroup key={b} label={b}>
          {cs.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} (FC{c.feederClass})
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Meter({ value, warn = 90, bad = 75 }: { value: number | null; warn?: number; bad?: number }) {
  if (value === null) return <span className="muted">-</span>;
  const cls = value >= warn ? 'good' : value >= bad ? 'warn' : 'bad';
  return (
    <span className="meter" title={`${value.toFixed(1)}%`}>
      <span className="meter-track">
        <span className={`meter-fill ${cls}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </span>
      <span className="meter-num">{value.toFixed(1)}%</span>
    </span>
  );
}
