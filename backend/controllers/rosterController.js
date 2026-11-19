const {
  AuditLog, Employee, RosterEntry, WorkShift,
} = require('../models');
const { overlaps } = require('../utils/workShiftTime');

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function sameId(left, right) {
  return String(left?._id || left) === String(right?._id || right);
}

function dateValue(value) {
  const date = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw statusError('Enter a valid calendar date', 400);
  }
  return parsed;
}

function dateStart(value) {
  return dateValue(value);
}

function assertMonday(value) {
  const start = dateValue(value);
  if (start.getUTCDay() !== 1) throw statusError('Week start must be a Monday', 400);
  return start;
}

function dayRange(start) {
  return { $gte: start, $lt: new Date(start.getTime() + 7 * 86400000) };
}

function selectedLocation(req) {
  if (!req.locationId) throw statusError('Select a location', 400);
  return req.locationId;
}

function validateLocationForAssignment(employee, shift, locationId) {
  if (!employee || employee.status !== 'ACTIVE' || !sameId(employee.locationId, locationId)) {
    throw statusError('Select an active employee assigned to this outlet', 400);
  }
  if (!shift || !shift.isActive || !sameId(shift.locationId, locationId)) {
    throw statusError('Select an active work shift at this outlet', 400);
  }
}

async function audit(req, action, entity, entityId, before, after) {
  return AuditLog.create({
    actorId: req.user._id, action, entity, entityId, before, after, ipAddress: req.ip,
  });
}

async function listRoster(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const start = assertMonday(req.query.weekStart);
    const ownEmployee = await Employee.findOne({ userId: req.user._id, status: 'ACTIVE' });
    const selfOnly = ownEmployee && !req.user.permissions.includes('hr.shift-roster:write')
      && !req.user.permissions.includes('*');
    const employeeFilter = { locationId, status: 'ACTIVE' };
    if (selfOnly) employeeFilter._id = ownEmployee._id;
    const employees = await Employee.find(employeeFilter).sort({ name: 1 }).lean();
    const workShifts = await WorkShift.find({ locationId }).sort({ startTime: 1 }).lean();
    const entryFilter = { locationId, date: dayRange(start) };
    if (selfOnly) entryFilter.employeeId = ownEmployee._id;
    const entries = await RosterEntry.find(entryFilter)
      .sort({ date: 1 }).lean();
    return res.json({ success: true, employees, workShifts, entries });
  } catch (error) {
    return next(error);
  }
}

async function assignShift(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const employee = await Employee.findById(req.body.employeeId);
    const shift = await WorkShift.findById(req.body.workShiftId);
    validateLocationForAssignment(employee, shift, locationId);
    const date = dateValue(req.body.date);
    const sameDay = await RosterEntry.find({ employeeId: employee._id, date }).lean();
    for (const entry of sameDay) {
      if (sameId(entry.workShiftId, shift._id)) throw statusError('This shift is already assigned for that date', 409);
      const otherShift = await WorkShift.findById(entry.workShiftId);
      if (otherShift && overlaps(shift, otherShift)) {
        throw statusError('An employee cannot have overlapping shifts on the same date', 409);
      }
    }
    const rosterEntry = await RosterEntry.create({
      employeeId: employee._id,
      workShiftId: shift._id,
      date,
      locationId,
      notes: req.body.notes,
      createdBy: req.user._id,
    });
    await audit(req, 'CREATE', 'RosterEntry', rosterEntry._id, undefined, rosterEntry.toObject());
    return res.status(201).json({ success: true, rosterEntry });
  } catch (error) {
    if (error.code === 11000) return next(statusError('This shift is already assigned for that date', 409));
    return next(error);
  }
}

async function removeShift(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const entry = await RosterEntry.findById(req.params.id);
    if (!entry || !sameId(entry.locationId, locationId)) throw statusError('Roster entry not found', 404);
    await audit(req, 'DELETE', 'RosterEntry', entry._id, entry.toObject(), undefined);
    await RosterEntry.deleteOne({ _id: entry._id });
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
}

async function copyLastWeek(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const start = assertMonday(req.body.weekStart);
    const previousStart = new Date(start.getTime() - 7 * 86400000);
    const source = await RosterEntry.find({ locationId, date: dayRange(previousStart) }).lean();
    if (!source.length) throw statusError('There are no assignments in the previous week to copy', 409);

    const targetEntries = await RosterEntry.find({ locationId, date: dayRange(start) }).lean();
    const employees = await Employee.find({ locationId, status: 'ACTIVE' }).lean();
    const workShifts = await WorkShift.find({ locationId }).lean();
    const employeeMap = new Map(employees.map((employee) => [String(employee._id), employee]));
    const shiftMap = new Map(workShifts.map((shift) => [String(shift._id), shift]));
    const planned = [];

    source.forEach((entry) => {
      const employee = employeeMap.get(String(entry.employeeId));
      const shift = shiftMap.get(String(entry.workShiftId));
      validateLocationForAssignment(employee, shift, locationId);
      const date = new Date(dateStart(entry.date).getTime() + 7 * 86400000);
      const sameEmployeeDay = [...targetEntries, ...planned].filter((candidate) => (
        sameId(candidate.employeeId, entry.employeeId)
        && dateStart(candidate.date).getTime() === date.getTime()
      ));
      sameEmployeeDay.forEach((candidate) => {
        if (sameId(candidate.workShiftId, entry.workShiftId)) {
          throw statusError('The destination week already contains this assignment', 409);
        }
        const otherShift = shiftMap.get(String(candidate.workShiftId));
        if (otherShift && overlaps(shift, otherShift)) {
          throw statusError('Copying would create overlapping employee shifts', 409);
        }
      });
      planned.push({
        employeeId: entry.employeeId,
        workShiftId: entry.workShiftId,
        date,
        locationId,
        ...(entry.notes ? { notes: entry.notes } : {}),
        createdBy: req.user._id,
      });
    });

    const rosterEntries = [];
    for (const values of planned) {
      const rosterEntry = await RosterEntry.create(values);
      await audit(req, 'CREATE', 'RosterEntry', rosterEntry._id, undefined, rosterEntry.toObject());
      rosterEntries.push(rosterEntry);
    }
    return res.status(201).json({ success: true, copied: rosterEntries.length });
  } catch (error) {
    if (error.code === 11000) return next(statusError('The destination week already contains this assignment', 409));
    return next(error);
  }
}

async function myUpcomingRoster(req, res, next) {
  try {
    const employee = await Employee.findOne({ userId: req.user._id, status: 'ACTIVE' });
    if (!employee) return res.json({ success: true, employee: null, entries: [] });
    const today = dateValue(new Date().toISOString().slice(0, 10));
    const entries = await RosterEntry.find({ employeeId: employee._id, date: { $gte: today } })
      .sort({ date: 1 }).lean();
    const shifts = await WorkShift.find({ _id: { $in: entries.map((entry) => entry.workShiftId) } }).lean();
    const shiftsById = new Map(shifts.map((shift) => [String(shift._id), shift]));
    return res.json({
      success: true,
      employee: { _id: employee._id, name: employee.name, employeeCode: employee.employeeCode },
      entries: entries.map((entry) => ({ ...entry, workShift: shiftsById.get(String(entry.workShiftId)) || null })),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  assignShift, copyLastWeek, listRoster, myUpcomingRoster, removeShift,
};
