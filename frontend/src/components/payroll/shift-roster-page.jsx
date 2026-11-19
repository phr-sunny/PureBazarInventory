'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { Button, Card, Input, Select } from '@/components/ui';
import { canSelectAccountingLocation } from '@/components/finance/accounting-location-filter';
import { getLocations } from '@/services/stock';
import {
  assignRosterShift, copyLastWeekRoster, getMyRoster, getShiftRoster, removeRosterShift,
} from '@/services/payroll';
import { T } from '@/i18n/language-provider';
import useToastMessages from '@/hooks/use-toast-messages';

const can = (permissions, key) => permissions.includes('*') || permissions.includes(key);
const assignedLocation = (user) => String(user?.locationId?._id || user?.locationId || '');

function monday(date) {
  const value = new Date(date);
  value.setHours(12, 0, 0, 0);
  value.setDate(value.getDate() - ((value.getDay() + 6) % 7));
  return value;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function dateFromKey(value) {
  const key = typeof value === 'string' ? value.slice(0, 10) : dateKey(value);
  return new Date(`${key}T12:00:00`);
}

function weekDate(value, offset) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + offset);
  return date;
}

function formatDay(date) {
  return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

const idOf = (value) => String(value?._id || value || '');

export default function ShiftRosterPage() {
  const { token, user, initialized } = useSelector((state) => state.auth);
  const permissions = user?.permissions || [];
  const canRead = can(permissions, 'hr.shift-roster:read');
  const canWrite = can(permissions, 'hr.shift-roster:write');
  const canChooseLocation = canSelectAccountingLocation(user);
  const [locations, setLocations] = useState([]);
  const [locationId, setLocationId] = useState('');
  const [weekStart, setWeekStart] = useState(() => dateKey(monday(new Date())));
  const [employees, setEmployees] = useState([]);
  const [workShifts, setWorkShifts] = useState([]);
  const [entries, setEntries] = useState([]);
  const [myEmployee, setMyEmployee] = useState(null);
  const [myEntries, setMyEntries] = useState([]);
  const [assignmentNote, setAssignmentNote] = useState('');
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
    if (!token || !canRead) return undefined;
    let active = true;
    setLoading(true);
    setError('');
    if (!canWrite) {
      getMyRoster(token).then(async ({ data }) => {
        if (!active) return;
        if (data.employee) {
          setMyEmployee(data.employee);
          setMyEntries(data.entries);
          setEmployees([]);
          setWorkShifts([]);
          setEntries([]);
          return;
        }
        setMyEmployee(null);
        setMyEntries([]);
        if (!locationId) return;
        const roster = await getShiftRoster(token, locationId, weekStart);
        if (!active) return;
        setEmployees(roster.data.employees);
        setWorkShifts(roster.data.workShifts);
        setEntries(roster.data.entries);
      }).catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load the shift roster.',
      )).finally(() => active && setLoading(false));
    } else if (!locationId) {
      setEmployees([]);
      setWorkShifts([]);
      setEntries([]);
      setLoading(false);
    } else {
      getShiftRoster(token, locationId, weekStart).then(({ data }) => {
        if (!active) return;
        setEmployees(data.employees);
        setWorkShifts(data.workShifts);
        setEntries(data.entries);
      }).catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load the shift roster.',
      )).finally(() => active && setLoading(false));
    }
    return () => { active = false; };
  }, [canRead, canWrite, locationId, reload, token, weekStart]);

  const days = useMemo(() => Array.from({ length: 7 }, (_, index) => {
    const date = weekDate(weekStart, index);
    return { date, key: dateKey(date), label: formatDay(date) };
  }), [weekStart]);
  const shiftMap = useMemo(
    () => new Map(workShifts.map((shift) => [String(shift._id), shift])),
    [workShifts],
  );

  async function assign(employeeId, date, workShiftId) {
    if (!workShiftId) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await assignRosterShift(token, locationId, {
        employeeId, workShiftId, date, ...(assignmentNote ? { notes: assignmentNote } : {}),
      });
      setNotice('Work shift assigned.');
      setAssignmentNote('');
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to assign this work shift.');
    } finally {
      setBusy(false);
    }
  }

  async function remove(entry) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await removeRosterShift(token, locationId, entry._id);
      setNotice('Work shift removed.');
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to remove this work shift.');
    } finally {
      setBusy(false);
    }
  }

  async function copyWeek() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const { data } = await copyLastWeekRoster(token, locationId, weekStart);
      setNotice(`${data.copied} assignment${data.copied === 1 ? '' : 's'} copied from last week.`);
      setReload((value) => value + 1);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to copy last week’s roster.');
    } finally {
      setBusy(false);
    }
  }

  function entriesFor(employeeId, date) {
    return entries.filter((entry) => idOf(entry.employeeId) === String(employeeId)
      && String(entry.date).slice(0, 10) === date);
  }

  if (!initialized) return <p role="status" className="py-10 text-center text-sm text-slate-500"><T>{"Loading shift roster..."}</T></p>;
  if (!token || !canRead) return <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><T>{"You do not have permission to view the shift roster."}</T></p>;

  return (
    <section className="space-y-5">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-slate-500"><T>{"HR / Payroll"}</T></p>
        <h1 className="text-2xl font-semibold text-slate-900"><T>{"Shift Roster"}</T></h1>
        <p className="mt-1 text-sm text-slate-600"><T>{"Plan employee work shifts by outlet and week."}</T></p>
      </div>
      {myEmployee && !canWrite ? (
        <Card title="My upcoming shifts" description={myEmployee.name}>
          {loading ? <p role="status" className="py-6 text-center text-sm text-slate-500"><T>{"Loading upcoming shifts..."}</T></p>
            : myEntries.length ? <div className="space-y-3">
              {myEntries.map((entry) => (
                <article key={entry._id} className="rounded-lg border border-slate-200 p-4">
                  <strong>{formatDay(dateFromKey(entry.date))}</strong>
                  <p className="mt-1 text-sm text-slate-600">
                    {entry.workShift?.name || 'Work shift'} · {entry.workShift?.startTime || '—'}–{entry.workShift?.endTime || '—'}
                  </p>
                  {entry.notes && <p className="mt-1 text-sm text-slate-500">{entry.notes}</p>}
                </article>
              ))}
            </div> : <p className="py-6 text-center text-sm text-slate-500"><T>{"You have no upcoming work shifts."}</T></p>}
        </Card>
      ) : (
        <Card title="Weekly roster" description="The first column stays visible while you scroll across the week.">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            {canChooseLocation && (
              <Select label="Outlet" name="locationId" value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                {!locationId && <option value="">Select an outlet</option>}
                {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
              </Select>
            )}
            {!myEmployee && <div className="flex items-center gap-2">
              <Button variant="secondary" disabled={busy} onClick={() => setWeekStart(dateKey(weekDate(weekStart, -7)))}>Previous week</Button>
              <Button variant="secondary" disabled={busy} onClick={() => setWeekStart(dateKey(weekDate(weekStart, 7)))}>Next week</Button>
              {canWrite && <Button variant="secondary" disabled={busy || !locationId} onClick={copyWeek}>Copy last week</Button>}
            </div>}
            {!canWrite && <p className="pb-2 text-sm text-slate-600">{days[0]?.label} – {days[6]?.label}</p>}
            {canWrite && <Input label="Note for next assignment" name="assignmentNote" maxLength={500} value={assignmentNote} onChange={(event) => setAssignmentNote(event.target.value)} />}
          </div>
          {loading ? <p role="status" className="py-8 text-center text-sm text-slate-500"><T>{"Loading roster..."}</T></p>
            : !locationId ? <p className="py-8 text-center text-sm text-slate-500"><T>{"Select an outlet to view its roster."}</T></p>
              : (
                <>
                  <div className="hidden overflow-x-auto md:block">
                    <table className="min-w-[1120px] w-full border-collapse text-left text-sm">
                      <thead><tr className="border-b bg-slate-50 text-xs uppercase text-slate-500">
                        <th className="sticky left-0 z-20 min-w-48 bg-slate-50 px-3 py-3">Employee</th>
                        {days.map((day) => <th key={day.key} className="min-w-36 px-3 py-3">{day.label}</th>)}
                      </tr></thead>
                      <tbody>{employees.map((employee) => (
                        <tr key={employee._id} className="border-b last:border-0">
                          <th scope="row" className="sticky left-0 z-10 bg-white px-3 py-3 align-top font-medium text-slate-800">
                            {employee.name}<small className="block text-slate-500">{employee.employeeCode}</small>
                          </th>
                          {days.map((day) => (
                            <td key={day.key} className="px-2 py-2 align-top">
                              <div className="space-y-2">
                                {entriesFor(employee._id, day.key).map((entry) => {
                                  const shift = shiftMap.get(idOf(entry.workShiftId));
                                  return <div key={entry._id} className="rounded border border-slate-200 bg-slate-50 p-2 text-xs">
                                    <span className="block font-medium">{shift?.name || 'Work shift'}</span>
                                    <span className="text-slate-500">{shift?.startTime}–{shift?.endTime}</span>
                                    {entry.notes && <span className="block text-slate-500">{entry.notes}</span>}
                                    {canWrite && <button className="ml-2 text-red-700 underline" disabled={busy} onClick={() => remove(entry)}>Remove</button>}
                                  </div>;
                                })}
                                {canWrite && <Select label={`Assign shift to ${employee.name}, ${day.label}`} name={`shift-${employee._id}-${day.key}`} value="" disabled={busy} onChange={(event) => assign(employee._id, day.key, event.target.value)}>
                                  <option value="">Assign...</option>
                                  {workShifts.filter((shift) => shift.isActive).map((shift) => <option key={shift._id} value={shift._id}>{shift.name} ({shift.startTime}–{shift.endTime})</option>)}
                                </Select>}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                        {!employees.length && <tr><td colSpan={8} className="px-3 py-8 text-center text-slate-500"><T>{"No active employees are assigned to this outlet."}</T></td></tr>}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-4 md:hidden">
                    {employees.map((employee) => (
                      <article key={employee._id} className="rounded-lg border border-slate-200 p-4">
                        <h2 className="font-semibold text-slate-900">{employee.name}</h2>
                        <p className="text-xs text-slate-500">{employee.employeeCode}</p>
                        <div className="mt-3 space-y-3">
                          {days.map((day) => (
                            <div key={day.key} className="border-t border-slate-100 pt-2">
                              <strong className="text-sm">{day.label}</strong>
                              <div className="mt-1 space-y-2">
                                {entriesFor(employee._id, day.key).map((entry) => {
                                  const shift = shiftMap.get(idOf(entry.workShiftId));
                                  return <div key={entry._id} className="flex items-center justify-between gap-2 rounded bg-slate-50 p-2 text-sm">
                                    <span>{shift?.name || 'Work shift'} · {shift?.startTime}–{shift?.endTime}{entry.notes ? ` · ${entry.notes}` : ''}</span>
                                    {canWrite && <Button size="sm" variant="secondary" disabled={busy} onClick={() => remove(entry)}>Remove</Button>}
                                  </div>;
                                })}
                                {canWrite && <Select label={`Assign shift to ${employee.name}, ${day.label}`} name={`mobile-shift-${employee._id}-${day.key}`} value="" disabled={busy} onChange={(event) => assign(employee._id, day.key, event.target.value)}>
                                  <option value="">Assign a shift</option>
                                  {workShifts.filter((shift) => shift.isActive).map((shift) => <option key={shift._id} value={shift._id}>{shift.name} ({shift.startTime}–{shift.endTime})</option>)}
                                </Select>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                    {!employees.length && <p className="py-6 text-center text-sm text-slate-500"><T>{"No active employees are assigned to this outlet."}</T></p>}
                  </div>
                </>
              )}
        </Card>
      )}
    </section>
  );
}
