import type { FieldDef } from './types';

/** Renders the extra data a workflow step captures (estimate amount, channel, etc.). */
export function StepFields({ fields, values, onChange }: { fields: FieldDef[]; values: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void }) {
  const set = (k: string, v: unknown) => onChange({ ...values, [k]: v });
  return (
    <>
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.required && <span className="req"> *</span>}
          {f.type === 'boolean' ? (
            <select value={values[f.name] === undefined ? '' : String(values[f.name])} onChange={(e) => set(f.name, e.target.value === '' ? undefined : e.target.value === 'true')} required={f.required}>
              <option value="">Select...</option>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </select>
          ) : f.type === 'select' ? (
            <select value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value || undefined)} required={f.required}>
              <option value="">Select...</option>
              {f.options?.map((o) => <option key={o} value={o}>{o.replace(/_/g, ' ').toLowerCase()}</option>)}
            </select>
          ) : f.type === 'datetime' ? (
            <input type="datetime-local" value={String(values[f.name] ?? '')} onChange={(e) => set(f.name, e.target.value || undefined)} required={f.required} />
          ) : (
            <input
              type={f.type === 'number' ? 'number' : 'text'}
              step={f.type === 'number' ? 'any' : undefined}
              value={String(values[f.name] ?? '')}
              onChange={(e) => set(f.name, e.target.value === '' ? undefined : f.type === 'number' ? Number(e.target.value) : e.target.value)}
              required={f.required}
            />
          )}
        </label>
      ))}
    </>
  );
}

/** datetime-local values are Sri Lanka time; convert them to ISO before sending. */
export function normaliseFieldValues(fields: FieldDef[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...values };
  for (const f of fields) {
    if (f.type === 'datetime' && typeof out[f.name] === 'string' && out[f.name]) out[f.name] = new Date(`${out[f.name]}:00+05:30`).toISOString();
  }
  return out;
}
