const {
  AuditLog, Location, RosterEntry, WorkShift,
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

function selectedLocation(req) {
  if (!req.locationId) throw statusError('Select a location', 400);
  return req.locationId;
}

async function ensureOutlet(locationId) {
  const location = await Location.findById(locationId);
  if (!location || location.type !== 'OUTLET' || location.isActive === false) {
    throw statusError('Select an active outlet', 400);
  }
}

async function audit(req, action, entity, entityId, before, after) {
  return AuditLog.create({
    actorId: req.user._id, action, entity, entityId, before, after, ipAddress: req.ip,
  });
}

async function listWorkShifts(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const workShifts = await WorkShift.find({ locationId }).sort({ startTime: 1, name: 1 }).lean();
    return res.json({ success: true, workShifts });
  } catch (error) {
    return next(error);
  }
}

async function createWorkShift(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    await ensureOutlet(locationId);
    if (req.body.startTime >= req.body.endTime) {
      throw statusError('End time must be later than start time', 400);
    }
    const workShift = await WorkShift.create({
      name: req.body.name,
      startTime: req.body.startTime,
      endTime: req.body.endTime,
      locationId,
    });
    await audit(req, 'CREATE', 'WorkShift', workShift._id, undefined, workShift.toObject());
    return res.status(201).json({ success: true, workShift });
  } catch (error) {
    if (error.code === 11000) return next(statusError('A shift with this name already exists at the outlet', 409));
    return next(error);
  }
}

async function updateWorkShift(req, res, next) {
  try {
    const locationId = selectedLocation(req);
    const workShift = await WorkShift.findById(req.params.id);
    if (!workShift || !sameId(workShift.locationId, locationId)) {
      throw statusError('Work shift not found', 404);
    }
    const before = workShift.toObject();
    const startTime = req.body.startTime ?? workShift.startTime;
    const endTime = req.body.endTime ?? workShift.endTime;
    if (startTime >= endTime) {
      throw statusError('End time must be later than start time', 400);
    }
    if (startTime !== workShift.startTime || endTime !== workShift.endTime) {
      const entries = await RosterEntry.find({ workShiftId: workShift._id }).lean();
      for (const entry of entries) {
        const sameDayEntries = await RosterEntry.find({
          employeeId: entry.employeeId, date: entry.date,
        }).lean();
        for (const otherEntry of sameDayEntries) {
          if (sameId(otherEntry._id, entry._id) || sameId(otherEntry.workShiftId, workShift._id)) continue;
          const otherShift = await WorkShift.findById(otherEntry.workShiftId);
          if (otherShift && overlaps({ startTime, endTime }, otherShift)) {
            throw statusError('Shift times overlap an employee assignment', 409);
          }
        }
      }
    }
    if (req.body.name !== undefined) workShift.name = req.body.name;
    workShift.startTime = startTime;
    workShift.endTime = endTime;
    if (req.body.isActive !== undefined) workShift.isActive = req.body.isActive;
    await workShift.save();
    await audit(req, 'UPDATE', 'WorkShift', workShift._id, before, workShift.toObject());
    return res.json({ success: true, workShift });
  } catch (error) {
    if (error.code === 11000) return next(statusError('A shift with this name already exists at the outlet', 409));
    return next(error);
  }
}

module.exports = { createWorkShift, listWorkShifts, updateWorkShift };
