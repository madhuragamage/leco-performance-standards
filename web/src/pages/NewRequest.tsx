import { type FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { CscSelect, ErrorBox, PageHead } from '../components';
import { useApp } from '../context';
import { fromLocalInput, toLocalInput } from '../format';
import { StepFields, normaliseFieldValues } from '../StepFields';
import type { ServiceDef } from '../types';

/** Services a role may lodge (e.g. a Technical Officer in the field, a clerk at the counter). */
export function lodgeableServices(all: ServiceDef[], role: string): ServiceDef[] {
  return all.filter((s) => role === 'ADMIN' || s.steps.find((st) => st.key === s.intakeStep)?.roles.includes(role));
}

export function NewRequestPage() {
  const { meta, user } = useApp();
  const services = lodgeableServices(meta.services, user.role);
  if (!services.length) {
    return (
      <>
        <PageHead title="New service request" />
        <div className="empty">Your role cannot lodge new requests.</div>
      </>
    );
  }
  return <NewRequestForm services={services} />;
}

function NewRequestForm({ services }: { services: ServiceDef[] }) {
  const { meta, user } = useApp();
  const nav = useNavigate();
  const [serviceType, setServiceType] = useState(services[0].code);
  const service = services.find((s) => s.code === serviceType)!;
  const intake = service.steps.find((s) => s.key === service.intakeStep)!;
  const intakeFields = (intake.fields ?? []).filter((f) => f.name !== 'expectedServiceDate');
  const [cscId, setCscId] = useState<number | ''>(user.cscId ?? '');
  const [form, setForm] = useState({ customerName: '', nic: '', mobile: '', email: '', address: '', accountNo: '', natureOfSupply: '', subType: '', expectedServiceDate: '', notes: '' });
  const [occurredAt, setOccurredAt] = useState(toLocalInput());
  const [intakeData, setIntakeData] = useState<Record<string, unknown>>({});
  const [reasonCodes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cscId) return setError('Select a CSC');
    setBusy(true);
    setError(null);
    try {
      const created = await api<{ id: number }>('/requests', {
        method: 'POST',
        body: {
          serviceType,
          cscId,
          source: user.role === 'AGENT' ? 'CALL_CENTER' : user.role === 'TO' ? 'FIELD' : 'COUNTER',
          customerName: form.customerName,
          nic: form.nic || null,
          mobile: form.mobile || null,
          email: form.email || null,
          address: form.address || null,
          accountNo: form.accountNo || null,
          natureOfSupply: form.natureOfSupply || null,
          subType: form.subType || null,
          expectedServiceDate: form.expectedServiceDate ? new Date(`${form.expectedServiceDate}T00:00:00+05:30`).toISOString() : null,
          occurredAt: fromLocalInput(occurredAt),
          intakeData: normaliseFieldValues(intakeFields, intakeData),
          reasonCodes,
          notes: form.notes || null,
        },
      });
      nav(`/requests/${created.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const isOutage = serviceType === 'SCHEDULED_OUTAGE';

  return (
    <>
      <PageHead title="New service request" sub="For counter, telephone, call-centre and field requests. Online applications arrive automatically from the customer portal." />
      <form className="card form-grid" onSubmit={submit}>
        <label className="span-2">
          Service
          <select value={serviceType} onChange={(e) => { setServiceType(e.target.value); setIntakeData({}); setForm({ ...form, natureOfSupply: '', subType: '' }); }}>
            {services.map((s) => <option key={s.code} value={s.code}>{s.name} (section {s.section})</option>)}
          </select>
        </label>
        <label>
          CSC<span className="req"> *</span>
          <CscSelect value={cscId} onChange={setCscId} allowAll={false} />
        </label>
        <label>
          {intake.label} - date/time<span className="req"> *</span>
          <input type="datetime-local" value={occurredAt} onChange={(e) => setOccurredAt(e.target.value)} required />
        </label>
        <label className="span-2">
          {isOutage ? 'Area / description' : 'Customer name'}<span className="req"> *</span>
          <input value={form.customerName} onChange={set('customerName')} required maxLength={200} />
        </label>
        {!isOutage && (
          <>
            <label>Account no<input value={form.accountNo} onChange={set('accountNo')} /></label>
            <label>NIC<input value={form.nic} onChange={set('nic')} /></label>
            <label>Mobile<input value={form.mobile} onChange={set('mobile')} inputMode="tel" /></label>
            <label>Email<input type="email" value={form.email} onChange={set('email')} /></label>
            <label className="span-2">Address<input value={form.address} onChange={set('address')} /></label>
          </>
        )}
        <label>
          Nature of supply
          <select value={form.natureOfSupply} onChange={set('natureOfSupply')}>
            <option value="">Not yet known</option>
            {service.natureOptions.map((n) => <option key={n} value={n}>{meta.natureLabels[n]}</option>)}
          </select>
        </label>
        {service.subTypes.length > 0 && (
          <label>
            Type
            <select value={form.subType} onChange={set('subType')}>
              <option value="">Select...</option>
              {service.subTypes.map((s) => <option key={s.code} value={s.code}>{s.label}</option>)}
            </select>
          </label>
        )}
        {!isOutage && (
          <label>
            Customer's expected date of service
            <input type="date" value={form.expectedServiceDate} onChange={set('expectedServiceDate')} />
          </label>
        )}
        <StepFields fields={intakeFields} values={intakeData} onChange={setIntakeData} />
        <label className="span-2">Notes<textarea value={form.notes} onChange={set('notes')} rows={2} /></label>
        <ErrorBox error={error} />
        <div className="span-2 form-actions">
          <button className="btn primary" disabled={busy}>{busy ? 'Saving...' : 'Create request'}</button>
        </div>
      </form>
    </>
  );
}
