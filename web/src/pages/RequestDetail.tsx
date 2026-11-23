import { type FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../api';
import { ComplianceBadge, ErrorBox, Modal, PageHead, StatusBadge } from '../components';
import { useApp } from '../context';
import { fmtDateTime, fmtLkr, fmtUnit, fromLocalInput, remainingText, toLocalInput, unitLong } from '../format';
import { StepFields, normaliseFieldValues } from '../StepFields';
import type { ClockEval, RequestDetail, ServiceDef } from '../types';

interface LateClock {
  key: string;
  label: string;
  elapsed: number;
  unit: ClockEval['unit'];
  internalTarget: number | null;
  regulatoryTarget: number | null;
  compliance: ClockEval['compliance'];
  penaltyAmount: number;
}

function ClockCard({ c, delay, reasonLabel }: { c: ClockEval; delay?: { delayReasons: string[]; delayNotes: string | null }; reasonLabel: (code: string) => string }) {
  if (c.state === 'NOT_APPLICABLE') return null;
  const lead = c.mode === 'MIN_LEAD';
  return (
    <div className={`clock clock-${c.compliance.toLowerCase()}`}>
      <div className="clock-head">
        <div>
          <div className="clock-title">{c.label}</div>
          <div className="muted small">
            {c.regulated ? `Regulated${c.lissReport ? ` - LISS ${c.lissReport}` : ''}` : 'LECO internal measure'}
          </div>
        </div>
        {c.state === 'NOT_STARTED' ? <span className="badge">Not started</span> : <ComplianceBadge c={c.compliance} paused={c.paused} />}
      </div>
      {c.state !== 'NOT_STARTED' && (
        <dl className="clock-body">
          <div>
            <dt>{lead ? 'Notice given' : c.state === 'RUNNING' ? 'Elapsed so far' : 'Took'}</dt>
            <dd className="big">{fmtUnit(c.elapsed, c.unit)}</dd>
            {c.excluded > 0 && <dd className="muted small">{fmtUnit(c.excluded, c.unit)} excluded (customer / wayleave)</dd>}
          </div>
          <div>
            <dt>LECO target</dt>
            <dd>{lead && c.internalTarget !== null ? 'min ' : ''}{fmtUnit(c.internalTarget, c.unit)}</dd>
            {c.state === 'RUNNING' && !lead && <dd className="muted small">{remainingText(c.remainingInternal, c.unit)} left</dd>}
          </div>
          <div>
            <dt>Regulatory target{c.provisional && c.regulatoryTarget !== null ? ' (provisional)' : ''}</dt>
            <dd>{lead && c.regulatoryTarget !== null ? 'min ' : ''}{fmtUnit(c.regulatoryTarget, c.unit)}</dd>
            {c.state === 'RUNNING' && !lead && <dd className="muted small">{remainingText(c.remainingRegulatory, c.unit)} left</dd>}
          </div>
          <div>
            <dt>{c.state === 'RUNNING' ? 'Compensation accruing' : 'Compensation'}</dt>
            <dd className={c.penaltyAmount ? 'text-bad' : ''}>{c.penaltyAmount ? fmtLkr(c.penaltyAmount) : '-'}</dd>
          </div>
          <div className="span-all muted small">
            Started {fmtDateTime(c.startedAt)}
            {c.state === 'STOPPED' && <> - stopped {fmtDateTime(c.endedAt)}</>}
            {lead && c.state === 'RUNNING' && <> - outage scheduled {fmtDateTime(c.endedAt)}</>}
          </div>
          {delay && delay.delayReasons.length > 0 && (
            <div className="span-all small">
              <strong>Reasons for not meeting the target:</strong> {delay.delayReasons.map(reasonLabel).join('; ')}
              {delay.delayNotes && <> - {delay.delayNotes}</>}
            </div>
          )}
        </dl>
      )}
    </div>
  );
}

const GROUP_LABEL: Record<string, string> = { NC: 'non-conformities', WL: 'wayleave issues', OBJ: 'objections' };

function RecordStep({ service, detail, onDone }: { service: ServiceDef; detail: RequestDetail; onDone: (d: RequestDetail) => void }) {
  const { meta } = useApp();
  const allowed = service.steps.filter((s) => detail.allowedSteps.includes(s.key));
  const openItems = detail.pauseItems.filter((i) => !i.closedAt);
  // "Next" steps: mandatory ones, plus closing open items (e.g. conformity) which is what the work is waiting on.
  // Optional "if applicable" steps are never pre-selected, so nothing gets recorded by accident.
  const primary = allowed.filter((s) => !s.optional || (s.pauseEnd && openItems.some((i) => i.group === s.pauseEnd)));
  const secondary = allowed.filter((s) => !primary.includes(s));
  const defaultKey = primary[0]?.key ?? '';
  const [stepKey, setStepKey] = useState(defaultKey);
  const step = service.steps.find((s) => s.key === stepKey);
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [data, setData] = useState<Record<string, unknown>>({});
  const [reasons, setReasons] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [late, setLate] = useState<LateClock[] | null>(null);
  const [delayReasons, setDelayReasons] = useState<string[]>([]);
  const [delayNotes, setDelayNotes] = useState('');

  useEffect(() => {
    setStepKey(defaultKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail.request.events.length]);
  useEffect(() => {
    setData({});
    setReasons([]);
    setError(null);
  }, [stepKey]);

  const roleNames = (roles: string[]) => roles.map((r) => meta.roles.find((x) => x.code === r)?.label ?? r).join(' / ');
  const codeLabel = (code: string) => meta.reasonCodes.find((r) => r.code === code)?.description ?? code;
  const openNc = openItems.filter((i) => i.group === 'NC');
  const waiting = (
    <>
      {openNc.length > 0 && (
        <div className="notice">
          Awaiting customer conformity for {openNc.length} non-conformit{openNc.length > 1 ? 'ies' : 'y'}. The work cannot proceed until each one is conformed.
        </div>
      )}
      {primary.length === 0 && detail.waitingFor.length > 0 && (
        <div className="notice">
          Next: {detail.waitingFor.map((w) => <span key={w.key}><strong>{w.label}</strong> - by {roleNames(w.roles)}. </span>)}
        </div>
      )}
    </>
  );

  if (detail.request.status !== 'OPEN' || !allowed.length) {
    return (
      <div className="card">
        <h2>Record next step</h2>
        {detail.request.status !== 'OPEN' ? <p className="muted">This request is {detail.request.status.toLowerCase()}.</p> : waiting}
        {detail.request.status === 'OPEN' && !detail.waitingFor.length && !openNc.length && <p className="muted">There are no steps your role can record at this point.</p>}
      </div>
    );
  }

  // Codes to tick: when closing items, only the ones still open; when reporting, the whole category -
  // and for a Yes/No check (e.g. "Non-conformities identified?"), only after answering Yes.
  const closing = !!step?.pauseEnd;
  const showReasons = !!step && (closing || (!!step.reasonCategory && (!step.reasonWhen || data[step.reasonWhen] === true)));
  const reasonOptions = !step
    ? []
    : closing
      ? openItems.filter((i) => i.group === step.pauseEnd).map((i) => ({ code: i.code, description: `${codeLabel(i.code)} (reported ${fmtDateTime(i.openedAt)})` }))
      : meta.reasonCodes.filter((r) => r.category === step.reasonCategory);
  const delayOptions = meta.reasonCodes.filter((r) => r.category === 'DELAY' && r.code !== 'SYS');

  async function send(withDelay: boolean) {
    setBusy(true);
    setError(null);
    try {
      const d = await api<RequestDetail>(`/requests/${detail.request.id}/events`, {
        method: 'POST',
        body: {
          stepKey,
          occurredAt: fromLocalInput(occurredAt),
          data: normaliseFieldValues(step!.fields ?? [], data),
          reasonCodes: showReasons ? reasons : [],
          notes: notes || null,
          ...(withDelay ? { delayReasons, delayNotes: delayNotes || null } : {}),
        },
      });
      setLate(null);
      setDelayReasons([]);
      setDelayNotes('');
      setNotes('');
      setOccurredAt(toLocalInput());
      onDone(d);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'DELAY_REASONS_REQUIRED') setLate(e.details as LateClock[]);
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send(false);
  };

  const amount = detail.request.estimateAmount;
  const approver = step?.approvalByAmount && amount !== null ? meta.approvalLimits.find((l) => l.upTo === null || amount <= l.upTo)?.role : null;
  const reasonLegend = closing
    ? `Which ${GROUP_LABEL[step!.pauseEnd!] ?? 'items'} has the customer conformed?`
    : step?.reasonCategory === 'NON_CONFORMITY'
      ? 'Tick every non-conformity identified'
      : step?.reasonCategory === 'WAYLEAVE'
        ? 'Wayleave issues'
        : 'Reasons';

  return (
    <form className="card record" onSubmit={submit}>
      <h2>Record next step</h2>
      {waiting}
      <label>
        Step
        <select value={stepKey} onChange={(e) => setStepKey(e.target.value)}>
          {primary.length === 0 && <option value="">Select an action (only if applicable)...</option>}
          {primary.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
          {secondary.length > 0 && (
            <optgroup label="Only if applicable">
              {secondary.map((s) => (
                <option key={s.key} value={s.key}>{s.label}</option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      {step && (
        <>
          {step.description && <p className="muted small">{step.description}</p>}
          {approver && <p className="small">Estimate {fmtLkr(amount)} - approval authority: <strong>{meta.roles.find((r) => r.code === approver)?.label}</strong> or above.</p>}
          <label>
            Date / time it happened
            <input type="datetime-local" value={occurredAt} max={toLocalInput()} onChange={(e) => setOccurredAt(e.target.value)} required />
          </label>
          <StepFields fields={step.fields ?? []} values={data} onChange={setData} />
          {showReasons && reasonOptions.length > 0 && (
            <fieldset>
              <legend>{reasonLegend}<span className="req"> *</span></legend>
              {reasonOptions.map((r) => (
                <label key={r.code} className="check">
                  <input type="checkbox" checked={reasons.includes(r.code)} onChange={(e) => setReasons(e.target.checked ? [...reasons, r.code] : reasons.filter((x) => x !== r.code))} />
                  <span><span className="mono">{r.code}</span> {r.description}</span>
                </label>
              ))}
              {closing && reasonOptions.length > 1 && (
                <button type="button" className="link small" onClick={() => setReasons(reasonOptions.map((r) => r.code))}>All conformed</button>
              )}
            </fieldset>
          )}
          {step.ncCheck && data.nonConformityFound === true && (
            <p className="muted small">The non-conformity report is issued to the customer. The clock pauses, and the next step is unlocked only after the customer conforms every item.</p>
          )}
          <label>
            Notes
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </label>
          <ErrorBox error={error} />
          <button className="btn primary" disabled={busy || (showReasons && !reasons.length)}>{busy ? 'Saving...' : 'Record step'}</button>
        </>
      )}

      {late && (
        <Modal title="Target not met - reasons required" onClose={() => setLate(null)}>
          <p>Recording this step stops the following measure{late.length > 1 ? 's' : ''} outside the target. Select the reasons for not meeting the target.</p>
          <ul className="late-list">
            {late.map((l) => (
              <li key={l.key}>
                <strong>{l.label}</strong>: {fmtUnit(l.elapsed, l.unit)} against LECO target {fmtUnit(l.internalTarget, l.unit)}
                {l.regulatoryTarget !== null && <> and regulatory target {fmtUnit(l.regulatoryTarget, l.unit)}</>}
                {' '}<ComplianceBadge c={l.compliance} />
                {l.penaltyAmount > 0 && <div className="text-bad small">Compensation payable to customer: {fmtLkr(l.penaltyAmount)}</div>}
              </li>
            ))}
          </ul>
          <fieldset>
            <legend>Reasons<span className="req"> *</span></legend>
            {delayOptions.map((r) => (
              <label key={r.code} className="check">
                <input type="checkbox" checked={delayReasons.includes(r.code)} onChange={(e) => setDelayReasons(e.target.checked ? [...delayReasons, r.code] : delayReasons.filter((x) => x !== r.code))} />
                <span>{r.description}</span>
              </label>
            ))}
          </fieldset>
          <label>
            Explanation
            <textarea rows={2} value={delayNotes} onChange={(e) => setDelayNotes(e.target.value)} />
          </label>
          <div className="form-actions">
            <button type="button" className="btn" onClick={() => setLate(null)}>Back</button>
            <button type="button" className="btn primary" disabled={!delayReasons.length || busy} onClick={() => void send(true)}>
              Record with reasons
            </button>
          </div>
        </Modal>
      )}
    </form>
  );
}

function EditDetails({ detail, service, onClose, onSaved }: { detail: RequestDetail; service: ServiceDef; onClose: () => void; onSaved: (d: RequestDetail) => void }) {
  const { meta } = useApp();
  const r = detail.request;
  const [f, setF] = useState({
    customerName: r.customerName,
    accountNo: r.accountNo ?? '',
    nic: r.nic ?? '',
    mobile: r.mobile ?? '',
    email: r.email ?? '',
    address: r.address ?? '',
    natureOfSupply: r.natureOfSupply ?? '',
    subType: r.subType ?? '',
    changesRequired: r.changesRequired === null ? '' : String(r.changesRequired),
  });
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function save(e: FormEvent) {
    e.preventDefault();
    try {
      const d = await api<RequestDetail>(`/requests/${r.id}`, {
        method: 'PATCH',
        body: {
          customerName: f.customerName,
          accountNo: f.accountNo || null,
          nic: f.nic || null,
          mobile: f.mobile || null,
          email: f.email || null,
          address: f.address || null,
          natureOfSupply: f.natureOfSupply || null,
          subType: f.subType || null,
          ...(service.hasChangesFlag ? { changesRequired: f.changesRequired === '' ? null : f.changesRequired === 'true' } : {}),
        },
      });
      onSaved(d);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Modal title="Edit request details" onClose={onClose} wide>
      <form className="form-grid" onSubmit={save}>
        <label className="span-2">Customer name<input value={f.customerName} onChange={set('customerName')} required /></label>
        <label>Account no<input value={f.accountNo} onChange={set('accountNo')} /></label>
        <label>NIC<input value={f.nic} onChange={set('nic')} /></label>
        <label>Mobile<input value={f.mobile} onChange={set('mobile')} /></label>
        <label>Email<input value={f.email} onChange={set('email')} /></label>
        <label className="span-2">Address<input value={f.address} onChange={set('address')} /></label>
        <label>
          Nature of supply
          <select value={f.natureOfSupply} onChange={set('natureOfSupply')}>
            <option value="">Not yet known</option>
            {service.natureOptions.map((n) => <option key={n} value={n}>{meta.natureLabels[n]}</option>)}
          </select>
        </label>
        {service.subTypes.length > 0 && (
          <label>
            Type
            <select value={f.subType} onChange={set('subType')}>
              <option value="">-</option>
              {service.subTypes.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </label>
        )}
        {service.hasChangesFlag && (
          <label>
            Changes required to distribution system
            <select value={f.changesRequired} onChange={set('changesRequired')}>
              <option value="">Not yet known</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          </label>
        )}
        <p className="span-2 muted small">Nature of supply and "changes required" decide which target applies; completed measures are re-evaluated when they change.</p>
        <ErrorBox error={error} />
        <div className="span-2 form-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

const ASSIGNERS = ['ADMIN', 'GM', 'HENG', 'SDM', 'BM', 'CSS', 'CLERK', 'BE'];

function AssignmentCard({ detail, onDone }: { detail: RequestDetail; onDone: (d: RequestDetail) => void }) {
  const { meta, user } = useApp();
  const r = detail.request;
  const [people, setPeople] = useState<{ id: number; fullName: string; role: string; canActNow: boolean }[] | null>(null);
  const [choice, setChoice] = useState<string>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const isAssigner = ASSIGNERS.includes(user.role);
  const open = r.status === 'OPEN';

  useEffect(() => {
    if (!open) return;
    api<typeof people>(`/requests/${r.id}/assignees`).then(setPeople).catch((e) => setError(e.message));
  }, [r.id, open, r.assignedTo?.id]);

  const roleLabel = (c: string) => meta.roles.find((x) => x.code === c)?.label ?? c;
  const eligibleSelf = people?.some((p) => p.id === user.id);

  async function assign(userId: number | null) {
    try {
      setError(null);
      onDone(await api<RequestDetail>(`/requests/${r.id}/assign`, { method: 'POST', body: { userId, note: note || null } }));
      setChoice('');
      setNote('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <section className="card">
      <h2>Assignment</h2>
      <p>
        {r.assignedTo ? (
          <>
            Assigned to <strong>{r.assignedTo.id === user.id ? 'you' : r.assignedTo.fullName}</strong> <span className="muted small">({roleLabel(r.assignedTo.role)}, {fmtDateTime(r.assignedAt)})</span>
          </>
        ) : (
          <span className="muted">Not assigned - it appears in the team queue of every officer whose role can act on the next step.</span>
        )}
      </p>
      {open && (
        <div className="assign-actions">
          {eligibleSelf && r.assignedTo?.id !== user.id && <button className="btn" onClick={() => assign(user.id)}>Take it</button>}
          {r.assignedTo && (isAssigner || r.assignedTo.id === user.id) && <button className="btn" onClick={() => assign(null)}>Unassign</button>}
        </div>
      )}
      {open && isAssigner && people && (
        <div className="assign-form">
          <label>
            Assign to
            <select value={choice} onChange={(e) => setChoice(e.target.value)}>
              <option value="">Select a person...</option>
              <optgroup label="Can act on the next step">
                {people.filter((p) => p.canActNow).map((p) => <option key={p.id} value={p.id}>{p.fullName} - {roleLabel(p.role)}</option>)}
              </optgroup>
              <optgroup label="Others working on this service">
                {people.filter((p) => !p.canActNow).map((p) => <option key={p.id} value={p.id}>{p.fullName} - {roleLabel(p.role)}</option>)}
              </optgroup>
            </select>
          </label>
          <label>
            Note
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
          </label>
          <button className="btn primary" disabled={!choice} onClick={() => assign(Number(choice))}>Assign</button>
        </div>
      )}
      <ErrorBox error={error} />
      {r.assignments.length > 0 && (
        <details className="small">
          <summary>History ({r.assignments.length})</summary>
          <ul className="plain">
            {r.assignments.map((a) => (
              <li key={a.id}>
                {fmtDateTime(a.at)}: {a.assignedTo ? `assigned to ${a.assignedTo.fullName}` : 'unassigned'} by {a.assignedBy?.fullName ?? 'system'}
                {a.note && <> - {a.note}</>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

export function RequestDetailPage({ onChanged }: { onChanged?: () => void }) {
  const { id } = useParams();
  const { meta, user } = useApp();
  const [detail, setDetailState] = useState<RequestDetail | null>(null);
  // Any change to the request may change someone's task list.
  const setDetail = useCallback(
    (d: RequestDetail) => {
      setDetailState(d);
      onChanged?.();
    },
    [onChanged],
  );
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  const load = useCallback(() => {
    api<RequestDetail>(`/requests/${id}`)
      .then(setDetailState)
      .catch((e) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);

  const service = useMemo(() => meta.services.find((s) => s.code === detail?.request.serviceType), [meta, detail]);
  const reasonLabel = useCallback((code: string) => meta.reasonCodes.find((r) => r.code === code)?.description ?? code, [meta]);

  if (error && !detail) return <ErrorBox error={error} />;
  if (!detail || !service) return <div className="muted">Loading...</div>;
  const r = detail.request;
  const virtual: Record<string, string> = { '@NC_OPENED': 'Non-conformity reported', '@NC_CLEARED': 'All non-conformities conformed' };
  const stepLabel = (k: string) => virtual[k] ?? service.steps.find((s) => s.key === k)?.label ?? k;
  const done = new Set(r.events.map((e) => e.stepKey));
  const canDelete = user.role === 'ADMIN' || user.role === 'BM';

  async function act(path: string, body: unknown, method = 'POST') {
    try {
      setError(null);
      setDetail(await api<RequestDetail>(path, { method, body }));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <>
      <PageHead
        title={r.refNo}
        sub={
          <>
            {service.name} - {r.csc.name} ({r.csc.branch?.name}, feeder class {r.csc.feederClass}) - <StatusBadge s={r.status} />
          </>
        }
        actions={
          <>
            <Link className="btn" to="/requests">Back</Link>
            {r.status === 'OPEN' && <button className="btn" onClick={() => setEditing(true)}>Edit details</button>}
            {r.status === 'OPEN' && ['ADMIN', 'BM', 'CSS', 'CLERK'].includes(user.role) && <button className="btn danger" onClick={() => setCancelling(true)}>Cancel request</button>}
          </>
        }
      />
      <ErrorBox error={error} />

      <section className="info-grid card">
        <div><span className="k">Customer</span><span>{r.customerName}</span></div>
        <div><span className="k">Account no</span><span>{r.accountNo ?? '-'}</span></div>
        <div><span className="k">Mobile / email</span><span>{[r.mobile, r.email].filter(Boolean).join(' / ') || '-'}</span></div>
        <div><span className="k">Address</span><span>{r.address ?? '-'}</span></div>
        <div><span className="k">Nature of supply</span><span>{r.natureOfSupply ? meta.natureLabels[r.natureOfSupply] : 'Not yet known'}</span></div>
        {service.subTypes.length > 0 && <div><span className="k">Type</span><span>{service.subTypes.find((s) => s.code === r.subType)?.label ?? '-'}</span></div>}
        {service.hasChangesFlag && <div><span className="k">Changes to distribution system</span><span>{r.changesRequired === null ? 'Not yet known' : r.changesRequired ? 'Yes' : 'No'}</span></div>}
        {r.wayleaveRequired !== null && <div><span className="k">Wayleave required</span><span>{r.wayleaveRequired ? 'Yes' : 'No'}</span></div>}
        {r.estimateAmount !== null && <div><span className="k">Estimate</span><span>{fmtLkr(r.estimateAmount)}</span></div>}
        {r.affectedCustomers !== null && <div><span className="k">Affected customers</span><span>{r.affectedCustomers}</span></div>}
        <div><span className="k">Source</span><span>{r.source.replace('_', ' ').toLowerCase()}{r.portalReference ? ` - ${r.portalReference}` : ''}</span></div>
        {r.expectedServiceDate && <div><span className="k">Customer expected date</span><span>{fmtDateTime(r.expectedServiceDate)}</span></div>}
        {r.details && typeof r.details.cancelReason === 'string' && <div className="span-all"><span className="k">Cancelled</span><span>{r.details.cancelReason}</span></div>}
      </section>

      <section className="clocks">
        {detail.evaluation.clocks.map((c) => (
          <ClockCard key={c.key} c={c} delay={r.clockResults.find((x) => x.clockKey === c.key)} reasonLabel={reasonLabel} />
        ))}
      </section>

      <div className="detail-grid">
        <div>
          <section className="card">
            <h2>Timeline</h2>
            <ol className="timeline">
              {r.events.map((e) => (
                <li key={e.id}>
                  <div className="tl-head">
                    <strong>{stepLabel(e.stepKey)}</strong>
                    <span className="muted small">{fmtDateTime(e.occurredAt)}</span>
                  </div>
                  <div className="muted small">
                    {e.recordedBy ? `${e.recordedBy.fullName}` : 'System (portal / ADMS)'}
                    {Math.abs(new Date(e.recordedAt).getTime() - new Date(e.occurredAt).getTime()) > 3_600_000 && ` - entered ${fmtDateTime(e.recordedAt)}`}
                  </div>
                  {e.reasonCodes.length > 0 && <div className="small">{e.reasonCodes.map((c) => `${c} - ${reasonLabel(c)}`).join('; ')}</div>}
                  {e.data && Object.keys(e.data).length > 0 && (
                    <div className="small kv">
                      {Object.entries(e.data).map(([k, v]) => (
                        <span key={k}>
                          {service.steps.find((s) => s.key === e.stepKey)?.fields?.find((f) => f.name === k)?.label ?? k}:{' '}
                          <b>{typeof v === 'boolean' ? (v ? 'Yes' : 'No') : typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v) ? fmtDateTime(v) : String(v)}</b>
                        </span>
                      ))}
                    </div>
                  )}
                  {e.notes && <div className="small">{e.notes}</div>}
                  {canDelete && r.events.length > 1 && (
                    <button className="link small danger-link" onClick={() => confirm('Remove this time stamp? Measures will be recalculated.') && act(`/requests/${r.id}/events/${e.id}`, undefined, 'DELETE')}>
                      Remove
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </section>

          <section className="card">
            <h2>KPIs ({service.kpiPrefix})</h2>
            <div className="table-wrap">
              <table>
                <thead><tr><th>KPI</th><th>Performance segment</th><th>Measurement</th><th className="num">Value</th></tr></thead>
                <tbody>
                  {detail.evaluation.kpis.map((k) => (
                    <tr key={k.code}>
                      <td className="mono small">{k.code}</td>
                      <td>{k.label}{k.remarks && <div className="muted small">{k.remarks}</div>}</td>
                      <td className="small muted">{stepLabel(k.to)} - {stepLabel(k.from)}</td>
                      <td className="num">{k.value === null ? '-' : fmtUnit(k.value, k.unit)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted small">KPI values are gross {unitLong[service.kpiUnit]} between time stamps (no exclusions).</p>
          </section>
        </div>

        <div>
          <RecordStep service={service} detail={detail} onDone={setDetail} />

          <AssignmentCard detail={detail} onDone={setDetail} />

          {detail.pauseItems.length > 0 && (
            <section className="card">
              <h2>Non-conformity / wayleave register</h2>
              <table className="dense">
                <thead><tr><th>Item</th><th>Reported</th><th>Conformed / closed</th></tr></thead>
                <tbody>
                  {detail.pauseItems.map((i, n) => (
                    <tr key={`${i.group}-${i.code}-${n}`}>
                      <td><span className="mono">{i.code}</span> {reasonLabel(i.code)}</td>
                      <td>{fmtDateTime(i.openedAt)}</td>
                      <td>{i.closedAt ? fmtDateTime(i.closedAt) : <span className="badge badge-paused">Awaiting customer</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="card">
            <h2>Workflow</h2>
            <ul className="steps">
              {service.steps.map((s) => (
                <li key={s.key} className={done.has(s.key) ? 'done' : s.optional ? 'optional' : ''}>
                  <span className="dot" aria-hidden />
                  <span>
                    {s.label}
                    {s.ncCheck && <span className="muted small"> - non-conformity check</span>}
                    {s.optional && <span className="muted small"> ({s.pauseEnd === 'NC' ? 'if non-conformity found' : s.availableIfText ? s.availableIfText.toLowerCase() : 'if applicable'})</span>}
                    <span className="muted small"> - {s.roles.join('/')}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section className="card">
            <h2>Customer feedback</h2>
            <div className="stars" role="radiogroup" aria-label="Rating">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} className={`star ${r.rating && n <= r.rating ? 'on' : ''}`} aria-label={`${n} star${n > 1 ? 's' : ''}`} onClick={() => act(`/requests/${r.id}/feedback`, { rating: n, comment: r.feedbackComment })}>
                  ★
                </button>
              ))}
            </div>
            {r.feedbackComment && <p className="small">{r.feedbackComment}</p>}
            <p className="muted small">Portal customers rate the service online; staff can record feedback taken at the counter or by phone.</p>
          </section>
        </div>
      </div>

      {editing && <EditDetails detail={detail} service={service} onClose={() => setEditing(false)} onSaved={(d) => { setDetail(d); setEditing(false); }} />}
      {cancelling && (
        <Modal title="Cancel request" onClose={() => setCancelling(false)}>
          <label>
            Reason
            <textarea rows={3} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
          </label>
          <div className="form-actions">
            <button className="btn" onClick={() => setCancelling(false)}>Back</button>
            <button className="btn danger" disabled={cancelReason.trim().length < 3} onClick={() => { void act(`/requests/${r.id}/cancel`, { reason: cancelReason }); setCancelling(false); }}>
              Cancel request
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
