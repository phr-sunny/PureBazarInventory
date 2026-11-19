'use client';

import { useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Button, Card, Input, Select } from '@/components/ui';
import { getLocations } from '@/services/stock';
import { canSelectAccountingLocation } from '@/components/finance/accounting-location-filter';
import { getWorkShifts, saveWorkShift } from '@/services/payroll';
import { T } from '@/i18n/language-provider';
import useToastMessages from '@/hooks/use-toast-messages';

const blankShift = () => ({ name: '', startTime: '', endTime: '' });
const can = (permissions, key) => permissions.includes('*') || permissions.includes(key);
const assignedLocation = (user) => String(user?.locationId?._id || user?.locationId || '');

export default function WorkShiftsPage() {
  const { token, user, initialized } = useSelector((state) => state.auth);
  const permissions = user?.permissions || [];
  const canRead = can(permissions, 'hr.work-shifts:read');
  const canWrite = can(permissions, 'hr.work-shifts:write');
  const canChooseLocation = canSelectAccountingLocation(user);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [shifts, setShifts] = useState([]);
  const [form, setForm] = useState(blankShift);
  const [editingId, setEditingId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useToastMessages({ success: notice, error });

  useEffect(() => {
    if (!token || !canRead) return undefined;
    let active = true;
    getLocations(token, 'OUTLET').then(({ data }) => {
      if (!active) return;
      const activeLocations = data.locations.filter((location) => location.isActive);
      const assigned = assignedLocation(user);
      setLocations(canChooseLocation ? activeLocations : activeLocations.filter((location) => location.id === assigned));
      setLocationId((current) => current || (canChooseLocation
        ? activeLocations[0]?.id || '' : assigned));
    }).catch((requestError) => active && setError(
      requestError.response?.data?.message || 'Unable to load locations.',
    ));
    return () => { active = false; };
  }, [canChooseLocation, canRead, token, user]);

  useEffect(() => {
    if (!token || !canRead || !locationId) {
      setShifts([]);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    setError('');
    getWorkShifts(token, locationId).then(({ data }) => active && setShifts(data.workShifts))
      .catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load work shifts.',
      )).finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [canRead, locationId, reload, token]);

  function editShift(shift) {
    setEditingId(shift._id);
    setForm({ name: shift.name, startTime: shift.startTime, endTime: shift.endTime });
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveWorkShift(token, locationId, form, editingId);
      setNotice(editingId ? 'Work shift updated.' : 'Work shift created.');
      setForm(blankShift());
      setEditingId('');
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to save this work shift.');
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(shift) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await saveWorkShift(token, locationId, { isActive: !shift.isActive }, shift._id);
      setNotice(shift.isActive ? 'Work shift deactivated.' : 'Work shift activated.');
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to update this work shift.');
    } finally {
      setBusy(false);
    }
  }

  if (!initialized) return <p role="status" className="py-10 text-center text-sm text-slate-500"><T>{"Loading work shifts..."}</T></p>;
  if (!token || !canRead) return <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><T>{"You do not have permission to view work shifts."}</T></p>;

  return (
    <section className="space-y-5">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-slate-500"><T>{"HR / Payroll"}</T></p>
        <h1 className="text-2xl font-semibold text-slate-900"><T>{"Work Shifts"}</T></h1>
        <p className="mt-1 text-sm text-slate-600"><T>{"Set the work shift names and times available for each outlet."}</T></p>
      </div>
      <Card title="Outlet shifts" description="Shift times are specific to the selected outlet.">
        <div className="mb-4 max-w-sm">
          <Select label="Outlet" name="locationId" value={locationId} onChange={(event) => {
            setLocationId(event.target.value);
            setEditingId('');
            setForm(blankShift());
          }}>
            {!locationId && <option value="">Select an outlet</option>}
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </Select>
        </div>
        {canWrite && locationId && (
          <form className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={submit}>
            <Input label="Shift name" name="name" required maxLength={100} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
            <Input label="Start time" name="startTime" type="time" required value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} />
            <Input label="End time" name="endTime" type="time" required value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} />
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={busy}>{busy ? 'Saving...' : editingId ? 'Save changes' : 'Add shift'}</Button>
              {editingId && <Button type="button" variant="secondary" onClick={() => { setEditingId(''); setForm(blankShift()); }}>Cancel</Button>}
            </div>
          </form>
        )}
        {loading ? <p role="status" className="py-6 text-center text-sm text-slate-500"><T>{"Loading work shifts..."}</T></p>
          : !locationId ? <p className="py-6 text-center text-sm text-slate-500"><T>{"Select an outlet to view its work shifts."}</T></p>
            : (
              <>
                <div className="hidden overflow-x-auto sm:block">
                  <table className="min-w-[620px] w-full border-collapse text-left text-sm">
                    <thead><tr className="border-b bg-slate-50 text-xs uppercase text-slate-500">
                      <th className="sticky left-0 z-10 bg-slate-50 px-3 py-3">Shift</th><th className="px-3 py-3">Start</th><th className="px-3 py-3">End</th><th className="px-3 py-3">Status</th>{canWrite && <th className="px-3 py-3">Actions</th>}
                    </tr></thead>
                    <tbody>{shifts.map((shift) => (
                      <tr key={shift._id} className="border-b last:border-0">
                        <th scope="row" className="sticky left-0 bg-white px-3 py-3 font-medium text-slate-800">{shift.name}</th>
                        <td className="px-3 py-3">{shift.startTime}</td><td className="px-3 py-3">{shift.endTime}</td>
                        <td className="px-3 py-3">{shift.isActive ? 'Active' : 'Inactive'}</td>
                        {canWrite && <td className="px-3 py-3"><div className="flex gap-2">
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => editShift(shift)}>Edit</Button>
                          <Button size="sm" variant="secondary" disabled={busy} onClick={() => toggleActive(shift)}>{shift.isActive ? 'Deactivate' : 'Activate'}</Button>
                        </div></td>}
                      </tr>
                    ))}
                      {!shifts.length && <tr><td colSpan={canWrite ? 5 : 4} className="px-3 py-8 text-center text-slate-500"><T>{"No work shifts have been configured."}</T></td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="space-y-3 sm:hidden">
                  {shifts.map((shift) => (
                    <article key={shift._id} className="rounded-lg border border-slate-200 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <strong>{shift.name}</strong><span className="text-xs text-slate-500">{shift.isActive ? 'Active' : 'Inactive'}</span>
                      </div>
                      <p className="mt-2 text-sm text-slate-600">{shift.startTime} – {shift.endTime}</p>
                      {canWrite && <div className="mt-3 flex gap-2">
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => editShift(shift)}>Edit</Button>
                        <Button size="sm" variant="secondary" disabled={busy} onClick={() => toggleActive(shift)}>{shift.isActive ? 'Deactivate' : 'Activate'}</Button>
                      </div>}
                    </article>
                  ))}
                  {!shifts.length && <p className="py-6 text-center text-sm text-slate-500"><T>{"No work shifts have been configured."}</T></p>}
                </div>
              </>
            )}
      </Card>
    </section>
  );
}
