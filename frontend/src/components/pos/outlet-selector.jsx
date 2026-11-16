'use client';

import { Select } from '@/components/ui';
import { T } from '@/i18n/language-provider';

export default function PosOutletSelector({
  isSuperAdmin, outlets, selectedOutletId, onChange, loading, error,
}) {
  if (!isSuperAdmin) return null;

  return (
    <div className="w-full max-w-sm">
      <Select
        label="Outlet"
        name="pos-outlet"
        value={selectedOutletId}
        onChange={onChange}
        disabled={loading || Boolean(error)}
      >
        <option value=""><T>{"Select an outlet"}</T></option>
        {outlets.map((outlet) => <option key={outlet.id} value={outlet.id}>{outlet.name}</option>)}
      </Select>
      {error && <p className="mt-1 text-sm text-red-700" role="alert">{error}</p>}
      {!loading && !error && !outlets.length && (
        <p className="mt-1 text-sm text-slate-500"><T>{"No active outlets are available."}</T></p>
      )}
    </div>
  );
}
