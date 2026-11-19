'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSelector } from 'react-redux';
import { Badge, Button, Card, Input, Select, Table } from '@/components/ui';
import AccountingLocationFilter, {
  accountingLocationParam, useAccountingLocations,
} from '@/components/finance/accounting-location-filter';
import AttendanceClockControl from '@/components/common/attendance-clock-control';
import {
  createAttendanceRecord, getAttendance, getMyAttendance, updateAttendanceRecord,
} from '@/services/payroll';
import useToastMessages from '@/hooks/use-toast-messages';

const can = (permissions, permission) => permissions.includes('*') || permissions.includes(permission);
const emptyForm = (date = '') => ({
  employeeId: '', date, clockIn: '', clockOut: '', reason: '', rosterEntryId: '',
});
const today = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};
const localInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const displayTime = (value) => value ? new Date(value).toLocaleString() : '—';

export default function AttendancePage() {
  const { token, user, initialized } = useSelector((state) => state.auth);
  const permissions = user?.permissions || [];
  const canRead = can(permissions, 'attendance:read');
  const canWrite = can(permissions, 'attendance:write');
  const { canSelect, locations, loadingLocations, locationError } = useAccountingLocations(token, user);
  const [date, setDate] = useState(today());
  const [selectedLocationId, setSelectedLocationId] = useState('all');
  const [rows, setRows] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [form, setForm] = useState(emptyForm(today()));
  const [editing, setEditing] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [hasLinkedEmployee, setHasLinkedEmployee] = useState(false);
  const [identityLoading, setIdentityLoading] = useState(!canRead);
  const canViewAttendance = canRead || hasLinkedEmployee;
  const isSuperAdmin = user?.role === 'Super Admin' || permissions.includes('*');
  const assignedLocationId = String(user?.locationId?._id || user?.locationId || '');
  const canWriteAtSelectedLocation = canWrite && (
    isSuperAdmin || !canSelect || selectedLocationId === assignedLocationId
  );
  useToastMessages({ success: notice, error });

  useEffect(() => {
    if (!token || canRead) {
      setIdentityLoading(false);
      return undefined;
    }
    let active = true;
    getMyAttendance(token).then(({ data }) => {
      if (active) setHasLinkedEmployee(Boolean(data.employee));
    }).catch((requestError) => {
      if (active) setError(requestError.response?.data?.message || 'Unable to verify employee attendance access.');
    }).finally(() => active && setIdentityLoading(false));
    return () => { active = false; };
  }, [canRead, token]);

  const load = useCallback(async () => {
    if (!token || !canViewAttendance) return;
    setLoading(true);
    setError('');
    try {
      const locationId = accountingLocationParam(user, selectedLocationId);
      const { data } = await getAttendance(token, {
        date,
        ...(locationId ? { locationId } : {}),
      });
      setRows(data.rows);
      setEmployees(data.employees);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load attendance.');
    } finally {
      setLoading(false);
    }
  }, [canViewAttendance, date, selectedLocationId, token, user]);

  useEffect(() => { load(); }, [load, reload]);

  function updateForm(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  function beginEdit(row) {
    setEditing({
      id: row._id,
      clockIn: localInput(row.clockIn),
      clockOut: localInput(row.clockOut),
      reason: '',
      rosterEntryId: row.rosterEntryId || '',
    });
  }

  async function saveManagerRecord(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const locationId = accountingLocationParam(user, selectedLocationId);
      const payload = {
        employeeId: form.employeeId,
        date: form.date,
        clockIn: new Date(form.clockIn).toISOString(),
        ...(form.clockOut ? { clockOut: new Date(form.clockOut).toISOString() } : {}),
        ...(form.rosterEntryId ? { rosterEntryId: form.rosterEntryId } : {}),
        ...(locationId ? { locationId } : {}),
        reason: form.reason,
      };
      await createAttendanceRecord(token, payload);
      setNotice('Attendance record added.');
      setForm(emptyForm(date));
      setReload((current) => current + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to add this attendance record.');
    } finally {
      setBusy(false);
    }
  }

  async function saveCorrection(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const locationId = accountingLocationParam(user, selectedLocationId);
      await updateAttendanceRecord(token, editing.id, {
        date,
        clockIn: new Date(editing.clockIn).toISOString(),
        clockOut: editing.clockOut ? new Date(editing.clockOut).toISOString() : null,
        ...(editing.rosterEntryId ? { rosterEntryId: editing.rosterEntryId } : {}),
        ...(locationId ? { locationId } : {}),
        reason: editing.reason,
      });
      setNotice('Attendance record corrected and audited.');
      setEditing(null);
      setReload((current) => current + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to correct this attendance record.');
    } finally {
      setBusy(false);
    }
  }

  function prepareAbsent(row) {
    setForm({
      employeeId: row.employeeId?._id || row.employeeId,
      date,
      clockIn: `${date}T${row.workShift?.startTime || '09:00'}`,
      clockOut: `${date}T${row.workShift?.endTime || '17:00'}`,
      reason: '',
      rosterEntryId: row.rosterEntryId || '',
    });
  }

  const columns = [
    { key: 'employee', label: 'Employee', render: (employee) => employee ? `${employee.employeeCode} · ${employee.name}` : '—' },
    { key: 'workShift', label: 'Shift', render: (shift) => shift?.name || '—' },
    { key: 'status', label: 'Status', render: (status) => <Badge tone={status === 'Absent' ? 'danger' : status === 'Unscheduled' ? 'warning' : 'success'}>{status}</Badge> },
    { key: 'clockIn', label: 'Clock in', render: displayTime },
    { key: 'clockOut', label: 'Clock out', render: displayTime },
    {
      key: 'flags',
      label: 'Flags',
      render: (_, row) => [row.late && 'Late', row.earlyLeave && 'Early leave', row.unscheduled && 'Unscheduled'].filter(Boolean).join(', ') || '—',
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, row) => canWriteAtSelectedLocation && row.status === 'Absent'
        ? <Button size="sm" variant="secondary" onClick={() => prepareAbsent(row)}>Add record</Button>
        : canWriteAtSelectedLocation && row.clockIn
          ? <Button size="sm" variant="secondary" onClick={() => beginEdit(row)}>Correct</Button>
          : '—',
    },
  ];

  if (!initialized) return <p role="status" className="py-10 text-center text-sm text-slate-500">Loading attendance…</p>;
  if (!token || (!canRead && identityLoading)) return <p role="status" className="py-10 text-center text-sm text-slate-500">Checking attendance access…</p>;
  if (!canViewAttendance) return <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">You do not have permission to view attendance.</p>;

  return (
    <section className="space-y-5">
      <header>
        <p className="mb-1 text-xs font-semibold uppercase text-slate-500">HR / Attendance</p>
        <h1 className="text-2xl font-semibold text-slate-900">Attendance</h1>
        <p className="mt-1 text-sm text-slate-600">Clock in and out, review shift attendance, and correct records with an audited reason.</p>
      </header>

      <Card title="Your attendance clock">
        <AttendanceClockControl token={token} />
      </Card>

      <Card title="Attendance records">
        <div className="mb-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Input label="Date" type="date" value={date} onChange={(event) => { setDate(event.target.value); setForm(emptyForm(event.target.value)); }} />
          <AccountingLocationFilter
            canSelect={canSelect}
            locations={locations}
            loading={loadingLocations}
            value={selectedLocationId}
            onChange={setSelectedLocationId}
          />
          <div className="flex items-end">
            <Button type="button" variant="secondary" disabled={loading} onClick={load}>{loading ? 'Loading…' : 'Refresh'}</Button>
          </div>
        </div>
        {locationError && <p role="alert" className="text-sm text-red-700">{locationError}</p>}

        {canWriteAtSelectedLocation && (
          <form onSubmit={saveManagerRecord} className="mb-5 grid gap-3 rounded-lg border border-slate-200 bg-slate-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <h2 className="text-sm font-semibold text-slate-800 sm:col-span-2 xl:col-span-4">Add a manager attendance record</h2>
            <Select label="Employee" required value={form.employeeId} onChange={(event) => updateForm('employeeId', event.target.value)}>
              <option value="">Select employee</option>
              {employees.map((employee) => <option key={employee._id} value={employee._id}>{employee.employeeCode} · {employee.name}</option>)}
            </Select>
            <Input label="Roster date" type="date" required value={form.date} onChange={(event) => updateForm('date', event.target.value)} />
            <Input label="Clock in time" type="datetime-local" required value={form.clockIn} onChange={(event) => updateForm('clockIn', event.target.value)} />
            <Input label="Clock out time (optional)" type="datetime-local" value={form.clockOut} onChange={(event) => updateForm('clockOut', event.target.value)} />
            <Input label="Reason (required)" required value={form.reason} onChange={(event) => updateForm('reason', event.target.value)} />
            <Button type="submit" disabled={busy || !form.employeeId || !form.clockIn || (canSelect && selectedLocationId === 'all')}>
              {busy ? 'Saving…' : 'Add attendance'}
            </Button>
          </form>
        )}

        {editing && (
          <form onSubmit={saveCorrection} className="mb-5 grid gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 sm:grid-cols-2 xl:grid-cols-4">
            <h2 className="text-sm font-semibold text-slate-800 sm:col-span-2 xl:col-span-4">Correct attendance record</h2>
            <Input label="Clock in" type="datetime-local" required value={editing.clockIn} onChange={(event) => setEditing((current) => ({ ...current, clockIn: event.target.value }))} />
            <Input label="Clock out (optional)" type="datetime-local" value={editing.clockOut} onChange={(event) => setEditing((current) => ({ ...current, clockOut: event.target.value }))} />
            <Input label="Reason (required)" required value={editing.reason} onChange={(event) => setEditing((current) => ({ ...current, reason: event.target.value }))} />
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={busy || !editing.reason}>{busy ? 'Saving…' : 'Save correction'}</Button>
              <Button type="button" variant="secondary" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </form>
        )}

        {loading ? <p role="status" className="py-6 text-center text-sm text-slate-500">Loading records…</p> : (
          <>
            <div className="hidden sm:block">
              <Table columns={columns} rows={rows} rowKey="rowKey" pageSize={15} emptyMessage="No attendance records for this date." />
            </div>
            <div className="space-y-3 sm:hidden">
              {rows.map((row) => (
                <article key={`${row.status}-${row._id}`} className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
                  <div className="flex items-start justify-between gap-2">
                    <strong className="text-slate-800">{row.employee?.name || 'Employee'}</strong>
                    <Badge tone={row.status === 'Absent' ? 'danger' : row.status === 'Unscheduled' ? 'warning' : 'success'}>{row.status}</Badge>
                  </div>
                  <p className="m-0 text-sm text-slate-600">{row.employee?.employeeCode} · {row.workShift?.name || 'No rostered shift'}</p>
                  <p className="m-0 text-xs text-slate-500">In: {displayTime(row.clockIn)} · Out: {displayTime(row.clockOut)}</p>
                  {row.status === 'Absent' && canWriteAtSelectedLocation && <Button size="sm" variant="secondary" onClick={() => prepareAbsent(row)}>Add record</Button>}
                  {row.clockIn && canWriteAtSelectedLocation && <Button size="sm" variant="secondary" onClick={() => beginEdit(row)}>Correct</Button>}
                </article>
              ))}
              {!rows.length && <p className="py-6 text-center text-sm text-slate-500">No attendance records for this date.</p>}
            </div>
          </>
        )}
      </Card>
    </section>
  );
}
