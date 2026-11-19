const {
  AttendanceRecord, Employee, RosterEntry, Settings, WorkShift,
} = require('../models');

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const idOf = (value) => String(value?._id || value || '');

function dateValue(value) {
  const date = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Enter a valid calendar date');
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error('Enter a valid calendar date');
  }
  return parsed;
}

function dhakaDateString(value) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function dayRange(date) {
  const start = dateValue(date);
  return { $gte: start, $lt: new Date(start.getTime() + 86400000) };
}

function localDayRange(date) {
  const start = dateValue(date).getTime() - DHAKA_OFFSET_MS;
  return { $gte: new Date(start), $lt: new Date(start + 86400000) };
}

function scheduledTime(rosterEntry, shift, time) {
  const date = new Date(rosterEntry.date);
  const [hours, minutes] = shift[time].split(':').map(Number);
  return new Date(Date.UTC(
    date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hours, minutes,
  ) - DHAKA_OFFSET_MS);
}

async function loadGraceMinutes() {
  const settings = await Settings.findOne({ singleton: 'global' }).lean();
  return Number.isInteger(settings?.lateGraceMinutes) ? settings.lateGraceMinutes : 10;
}

async function loadRosterMatch(employeeId, locationId, date, clockIn, rosterEntryId) {
  const entries = await RosterEntry.find({
    employeeId, locationId, date: dayRange(date),
  }).lean();
  if (!entries.length) {
    if (rosterEntryId) throw Object.assign(new Error('Roster entry does not belong to this employee, date, and location'), { status: 400 });
    return null;
  }
  const shifts = await WorkShift.find({
    _id: { $in: entries.map((entry) => entry.workShiftId) },
  }).lean();
  const shiftsById = new Map(shifts.map((shift) => [idOf(shift), shift]));
  if (rosterEntryId) {
    const entry = entries.find((item) => idOf(item) === idOf(rosterEntryId));
    if (!entry || !shiftsById.has(idOf(entry.workShiftId))) {
      throw Object.assign(new Error('Roster entry does not belong to this employee, date, and location'), { status: 400 });
    }
    return { entry, shift: shiftsById.get(idOf(entry.workShiftId)) };
  }

  const candidates = entries
    .map((entry) => ({ entry, shift: shiftsById.get(idOf(entry.workShiftId)) }))
    .filter((item) => item.shift)
    .sort((left, right) => scheduledTime(left.entry, left.shift, 'startTime')
      - scheduledTime(right.entry, right.shift, 'startTime'));
  if (!candidates.length) return null;
  const now = new Date(clockIn).getTime();
  const current = candidates.find(({ entry, shift }) => (
    now <= scheduledTime(entry, shift, 'endTime').getTime()
  ));
  return current || candidates[candidates.length - 1];
}

async function attendanceFlags({ employeeId, locationId, date, clockIn, clockOut, rosterEntryId }) {
  const matched = await loadRosterMatch(employeeId, locationId, date, clockIn, rosterEntryId);
  if (!matched) return { rosterEntryId: undefined, late: false, earlyLeave: false, unscheduled: true };
  const graceMinutes = await loadGraceMinutes();
  const shiftStart = scheduledTime(matched.entry, matched.shift, 'startTime').getTime();
  const shiftEnd = scheduledTime(matched.entry, matched.shift, 'endTime').getTime();
  return {
    rosterEntryId: matched.entry._id,
    late: new Date(clockIn).getTime() > shiftStart + graceMinutes * 60000,
    earlyLeave: Boolean(clockOut && new Date(clockOut).getTime() < shiftEnd),
    unscheduled: false,
  };
}

function monthRange(month) {
  const [year, value] = month.split('-').map(Number);
  const start = new Date(Date.UTC(year, value - 1, 1));
  return { $gte: start, $lt: new Date(Date.UTC(year, value, 1)) };
}

async function getMonthlyAttendanceSummaries(month, employeeIds, locationId = null, now = new Date()) {
  const range = monthRange(month);
  const rosterFilter = { date: range };
  const recordFilter = { clockIn: range };
  if (locationId) {
    rosterFilter.locationId = locationId;
    recordFilter.locationId = locationId;
  }
  if (employeeIds) {
    rosterFilter.employeeId = { $in: employeeIds };
    recordFilter.employeeId = { $in: employeeIds };
  }
  const [entries, records] = await Promise.all([
    RosterEntry.find(rosterFilter).lean(),
    AttendanceRecord.find(recordFilter).lean(),
  ]);
  const shifts = await WorkShift.find({
    _id: { $in: entries.map((entry) => entry.workShiftId) },
  }).lean();
  const shiftMap = new Map(shifts.map((shift) => [idOf(shift), shift]));
  const summaries = new Map();
  const summaryFor = (employeeId) => {
    const key = idOf(employeeId);
    if (!summaries.has(key)) {
      summaries.set(key, {
        rosteredShifts: 0, attended: 0, absent: 0, lateCount: 0, totalWorkedHours: 0,
      });
    }
    return summaries.get(key);
  };
  const recordsByRoster = new Map();
  records.forEach((record) => {
    const summary = summaryFor(record.employeeId);
    if (record.late) summary.lateCount += 1;
    if (record.clockOut) {
      const hours = Math.max(0, new Date(record.clockOut) - new Date(record.clockIn)) / 3600000;
      summary.totalWorkedHours += hours;
    }
    if (record.rosterEntryId) recordsByRoster.set(idOf(record.rosterEntryId), record);
  });
  entries.forEach((entry) => {
    const summary = summaryFor(entry.employeeId);
    summary.rosteredShifts += 1;
    const record = recordsByRoster.get(idOf(entry));
    if (record) {
      summary.attended += 1;
      return;
    }
    const shift = shiftMap.get(idOf(entry.workShiftId));
    if (shift && scheduledTime(entry, shift, 'endTime') <= now) summary.absent += 1;
  });
  summaries.forEach((summary) => {
    summary.totalWorkedHours = Number(summary.totalWorkedHours.toFixed(2));
  });
  return summaries;
}

async function getAttendanceReport(month, locationId, employeeFilter) {
  const employees = await Employee.find(employeeFilter).sort({ name: 1 }).lean();
  const summaries = await getMonthlyAttendanceSummaries(
    month, employees.map((employee) => employee._id), locationId,
  );
  return {
    month,
    rows: employees.map((employee) => ({
      employeeCode: employee.employeeCode,
      employeeName: employee.name,
      ...(summaries.get(String(employee._id)) || {
        rosteredShifts: 0, attended: 0, absent: 0, lateCount: 0, totalWorkedHours: 0,
      }),
    })),
  };
}

module.exports = {
  attendanceFlags,
  dateValue,
  dayRange,
  dhakaDateString,
  getAttendanceReport,
  getMonthlyAttendanceSummaries,
  localDayRange,
};
