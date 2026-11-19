const {
  AttendanceRecord, AuditLog, Employee, RosterEntry, WorkShift,
} = require('../models');
const {
  attendanceFlags, dateValue, dayRange, dhakaDateString, getAttendanceReport, localDayRange,
} = require('../services/attendanceService');

const hasPermission = (user, permission) => user.permissions?.includes('*')
  || user.permissions?.includes(permission);
const sameId = (left, right) => String(left?._id || left) === String(right?._id || right);

function statusError(message, status) {
  return Object.assign(new Error(message), { status });
}

function toObject(value) {
  return value?.toObject ? value.toObject() : value;
}

async function audit(req, action, record, before, after) {
  await AuditLog.create({
    actorId: req.user._id,
    action,
    entity: 'AttendanceRecord',
    entityId: record._id,
    before,
    after,
    ipAddress: req.ip,
  });
}

async function findOwnEmployee(req) {
  return Employee.findOne({ userId: req.user._id, status: 'ACTIVE' });
}

async function me(req, res, next) {
  try {
    const employee = await findOwnEmployee(req);
    if (!employee) return res.json({ success: true, employee: null, openRecord: null });
    const openRecord = await AttendanceRecord.findOne({
      employeeId: employee._id, clockOut: null,
    });
    return res.json({
      success: true,
      employee: { _id: employee._id, name: employee.name, employeeCode: employee.employeeCode },
      openRecord: openRecord || null,
    });
  } catch (error) {
    return next(error);
  }
}

async function clockIn(req, res, next) {
  try {
    const employee = await findOwnEmployee(req);
    if (!employee) throw statusError('Your login is not linked to an active employee', 403);
    if (!req.user.locationId || !sameId(employee.locationId, req.user.locationId)) {
      throw statusError('Attendance is only available at your assigned location', 403);
    }
    const openRecord = await AttendanceRecord.findOne({ employeeId: employee._id, clockOut: null });
    if (openRecord) throw statusError('Clock out before starting another attendance record', 409);

    const clockInAt = new Date();
    const date = dhakaDateString(clockInAt);
    const flags = await attendanceFlags({
      employeeId: employee._id,
      locationId: employee.locationId,
      date,
      clockIn: clockInAt,
    });
    const record = await AttendanceRecord.create({
      employeeId: employee._id,
      locationId: employee.locationId,
      ...flags,
      clockIn: clockInAt,
      source: 'self',
      createdBy: req.user._id,
    });
    await audit(req, 'CREATE', record, undefined, toObject(record));
    return res.status(201).json({ success: true, record });
  } catch (error) {
    if (error.code === 11000) return next(statusError('Clock out before starting another attendance record', 409));
    return next(error);
  }
}

async function clockOut(req, res, next) {
  try {
    const employee = await findOwnEmployee(req);
    if (!employee) throw statusError('Your login is not linked to an active employee', 403);
    if (!req.user.locationId || !sameId(employee.locationId, req.user.locationId)) {
      throw statusError('Attendance is only available at your assigned location', 403);
    }
    const record = await AttendanceRecord.findOne({ employeeId: employee._id, clockOut: null });
    if (!record) throw statusError('There is no open attendance record to clock out', 409);
    const before = toObject(record);
    const clockOutAt = new Date();
    record.clockOut = clockOutAt;
    const date = dhakaDateString(record.clockIn);
    const flags = await attendanceFlags({
      employeeId: record.employeeId,
      locationId: record.locationId,
      date,
      clockIn: record.clockIn,
      clockOut: clockOutAt,
      rosterEntryId: record.rosterEntryId,
    });
    record.late = flags.late;
    record.earlyLeave = flags.earlyLeave;
    record.unscheduled = flags.unscheduled;
    await record.save();
    await audit(req, 'UPDATE', record, before, toObject(record));
    return res.json({ success: true, record });
  } catch (error) {
    return next(error);
  }
}

async function listAttendance(req, res, next) {
  try {
    const ownEmployee = await findOwnEmployee(req);
    if (!hasPermission(req.user, 'attendance:read') && !ownEmployee) {
      throw statusError('Insufficient permissions', 403);
    }
    const allLocations = Boolean(req.user.canViewAllLocations);
    const selfOnly = Boolean(ownEmployee) && (
      !hasPermission(req.user, 'attendance:read')
      || (!allLocations && !hasPermission(req.user, 'attendance:write'))
    );
    dateValue(req.query.date);
    const locationId = selfOnly ? ownEmployee.locationId : req.locationId;
    if (!locationId && !allLocations) throw statusError('User has no assigned location', 403);
    const employeeFilter = selfOnly
      ? { _id: ownEmployee._id }
      : { status: 'ACTIVE', ...(locationId ? { locationId } : {}) };
    const employees = await Employee.find(employeeFilter).sort({ name: 1 }).lean();
    const employeeIds = employees.map((employee) => employee._id);
    const recordFilter = { clockIn: localDayRange(req.query.date) };
    const rosterFilter = { date: dayRange(req.query.date) };
    if (locationId) {
      recordFilter.locationId = locationId;
      rosterFilter.locationId = locationId;
    }
    recordFilter.employeeId = { $in: employeeIds };
    rosterFilter.employeeId = { $in: employeeIds };
    const [records, rosterEntries] = await Promise.all([
      AttendanceRecord.find(recordFilter).sort({ clockIn: 1 }).lean(),
      RosterEntry.find(rosterFilter).lean(),
    ]);
    const shiftIds = rosterEntries.map((entry) => entry.workShiftId);
    const [shifts, allEmployees] = await Promise.all([
      WorkShift.find({ _id: { $in: shiftIds } }).lean(),
      Employee.find({ _id: { $in: employeeIds } }).lean(),
    ]);
    const shiftsById = new Map(shifts.map((shift) => [String(shift._id), shift]));
    const employeesById = new Map(allEmployees.map((employee) => [String(employee._id), employee]));
    const recordsByRoster = new Set(records.map((record) => String(record.rosterEntryId || '')));
    const rosterById = new Map(rosterEntries.map((entry) => [String(entry._id), entry]));
    const rows = records.map((record) => {
      const rosterEntry = rosterById.get(String(record.rosterEntryId));
      return {
        ...record,
        rowKey: `record-${record._id}`,
        status: record.unscheduled ? 'Unscheduled' : 'Present',
        employee: employeesById.get(String(record.employeeId)) || null,
        workShift: rosterEntry ? shiftsById.get(String(rosterEntry.workShiftId)) || null : null,
      };
    });
    const now = new Date();
    rosterEntries.forEach((entry) => {
      const shift = shiftsById.get(String(entry.workShiftId));
      if (!shift || recordsByRoster.has(String(entry._id))) return;
      const [hours, minutes] = shift.endTime.split(':').map(Number);
      const shiftEnd = new Date(Date.UTC(
        entry.date.getUTCFullYear(), entry.date.getUTCMonth(), entry.date.getUTCDate(), hours, minutes,
      ) - 6 * 60 * 60 * 1000);
      if (shiftEnd > now) return;
      rows.push({
        _id: entry._id,
        rowKey: `absent-${entry._id}`,
        employeeId: entry.employeeId,
        locationId: entry.locationId,
        rosterEntryId: entry._id,
        date: entry.date,
        status: 'Absent',
        employee: employeesById.get(String(entry.employeeId)) || null,
        workShift: shift,
      });
    });
    return res.json({
      success: true, rows, employees, locationId: locationId || null, date: req.query.date,
    });
  } catch (error) {
    return next(error);
  }
}

async function createManagerRecord(req, res, next) {
  try {
    if (!req.locationId) throw statusError('Select a location', 400);
    const employee = await Employee.findById(req.body.employeeId);
    if (!employee || !sameId(employee.locationId, req.locationId)) {
      throw statusError('Employee is not assigned to this location', 400);
    }
    dateValue(req.body.date);
    const clockInAt = new Date(req.body.clockIn);
    const clockOutAt = req.body.clockOut ? new Date(req.body.clockOut) : undefined;
    if (clockOutAt && clockOutAt < clockInAt) throw statusError('Clock out must be after clock in', 400);
    const openRecord = await AttendanceRecord.findOne({ employeeId: employee._id, clockOut: null });
    if (!clockOutAt && openRecord) throw statusError('Employee already has an open attendance record', 409);
    const flags = await attendanceFlags({
      employeeId: employee._id,
      locationId: req.locationId,
      date: req.body.date,
      clockIn: clockInAt,
      clockOut: clockOutAt,
      rosterEntryId: req.body.rosterEntryId,
    });
    const record = await AttendanceRecord.create({
      employeeId: employee._id,
      locationId: req.locationId,
      rosterEntryId: flags.rosterEntryId,
      clockIn: clockInAt,
      ...(clockOutAt ? { clockOut: clockOutAt } : {}),
      late: flags.late,
      earlyLeave: flags.earlyLeave,
      unscheduled: flags.unscheduled,
      source: 'manager',
      editReason: req.body.reason.trim(),
      createdBy: req.user._id,
    });
    await audit(req, 'CREATE', record, undefined, toObject(record));
    return res.status(201).json({ success: true, record });
  } catch (error) {
    if (error.code === 11000) return next(statusError('Employee already has an open attendance record', 409));
    return next(error);
  }
}

async function updateManagerRecord(req, res, next) {
  try {
    const record = await AttendanceRecord.findById(req.params.id);
    if (!record || !sameId(record.locationId, req.locationId)) {
      throw statusError('Attendance record not found', 404);
    }
    const employee = await Employee.findById(record.employeeId);
    if (!employee || !sameId(employee.locationId, req.locationId)) {
      throw statusError('Employee is not assigned to this location', 400);
    }
    const before = toObject(record);
    if (req.body.clockIn !== undefined) record.clockIn = new Date(req.body.clockIn);
    if (req.body.clockOut !== undefined) {
      record.clockOut = req.body.clockOut ? new Date(req.body.clockOut) : null;
    }
    if (record.clockOut && record.clockOut < record.clockIn) {
      throw statusError('Clock out must be after clock in', 400);
    }
    if (!record.clockOut) {
      const openRecord = await AttendanceRecord.findOne({ employeeId: employee._id, clockOut: null });
      if (openRecord && !sameId(openRecord, record)) {
        throw statusError('Employee already has another open attendance record', 409);
      }
    }
    const date = req.body.date || dhakaDateString(record.clockIn);
    const flags = await attendanceFlags({
      employeeId: record.employeeId,
      locationId: record.locationId,
      date,
      clockIn: record.clockIn,
      clockOut: record.clockOut,
      rosterEntryId: req.body.rosterEntryId || record.rosterEntryId,
    });
    record.rosterEntryId = flags.rosterEntryId;
    record.late = flags.late;
    record.earlyLeave = flags.earlyLeave;
    record.unscheduled = flags.unscheduled;
    record.source = 'manager';
    record.editReason = req.body.reason.trim();
    await record.save();
    await audit(req, 'UPDATE', record, before, toObject(record));
    return res.json({ success: true, record });
  } catch (error) {
    if (error.code === 11000) return next(statusError('Employee already has another open attendance record', 409));
    return next(error);
  }
}

module.exports = {
  clockIn,
  clockOut,
  createManagerRecord,
  getAttendanceReport,
  listAttendance,
  me,
  updateManagerRecord,
};
