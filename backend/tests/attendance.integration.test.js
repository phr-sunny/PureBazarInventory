const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');
const ExcelJS = require('exceljs');

jest.mock('../models', () => {
  const { fakeModel } = require('./helpers/fakeModel');
  const names = ['AttendanceRecord', 'Employee', 'Location', 'RosterEntry', 'Settings', 'WorkShift'];
  const stores = {};
  const models = { AuditLog: { create: jest.fn() }, __stores: stores, __users: [] };
  names.forEach((name) => {
    stores[name] = [];
    models[name] = fakeModel(jest.requireActual(`../models/${name}`), stores[name]);
  });
  models.User = {
    findById: jest.fn(() => ({ populate: jest.fn(async () => models.__users[0]) })),
  };
  const originalLocationFindById = models.Location.findById;
  models.Location.findById = (id) => {
    const result = originalLocationFindById(id);
    const query = {
      select: () => query,
      lean: () => result,
      then: (resolve, reject) => result.then(resolve, reject),
    };
    return query;
  };
  const originalSettingsFindOne = models.Settings.findOne;
  models.Settings.findOne = (filter) => {
    const value = originalSettingsFindOne(filter);
    const query = {
      lean: async () => {
        const document = await value;
        return document?.toObject ? document.toObject() : document || null;
      },
      then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
    };
    return query;
  };
  return models;
});

const models = require('../models');
const payrollRoutes = require('../routes/payrollRoutes');
const reportRoutes = require('../routes/reportRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');

const secret = 'attendance-test-secret';
const actorId = new mongoose.Types.ObjectId('65e100000000000000000001');
const locationA = new mongoose.Types.ObjectId('65e100000000000000000002');
const locationB = new mongoose.Types.ObjectId('65e100000000000000000003');
const app = express();
app.use(express.json());
app.use('/api/payroll', payrollRoutes);
app.use('/api/reports', reportRoutes);
app.use(errorMiddleware);

const nowDhakaDate = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => parts.find((part) => part.type === type).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};
const nextDate = (date) => new Date(`${date}T00:00:00.000Z`).getTime() + 86400000;
const stores = models.__stores;
const parseBinary = (response, callback) => {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => callback(null, Buffer.concat(chunks)));
};

describe('attendance and attendance report', () => {
  let actor;
  const token = () => jwt.sign({ sub: actorId.toString() }, secret);
  const auth = { get Authorization() { return `Bearer ${token()}`; } };
  const post = (url, body = {}) => request(app).post(url).set(auth).send(body);

  async function location(id, name) { return models.Location.create({ _id: id, type: 'OUTLET', name, isActive: true }); }
  async function employee(code, name, locationId, userId) {
    return models.Employee.create({ employeeCode: code, name, baseSalary: 1000, status: 'ACTIVE', locationId, userId });
  }
  async function shift(name, startTime, endTime, locationId) {
    return models.WorkShift.create({ name, startTime, endTime, locationId, isActive: true });
  }
  async function roster(worker, workShift, date, locationId) {
    return models.RosterEntry.create({
      employeeId: worker._id, workShiftId: workShift._id,
      date: new Date(`${date}T00:00:00.000Z`), locationId, createdBy: actorId,
    });
  }

  beforeEach(async () => {
    process.env.JWT_SECRET = secret;
    Object.values(stores).forEach((items) => { items.length = 0; });
    models.__users.length = 0;
    models.AuditLog.create.mockReset().mockResolvedValue({});
    actor = {
      _id: actorId, name: 'Attendance Manager', email: 'manager@example.test', isActive: true,
      locationId: { _id: locationA, name: 'Outlet A', type: 'OUTLET' },
      roleId: { _id: actorId, name: 'Outlet Manager', permissions: ['attendance:read', 'attendance:write'], canViewAllLocations: false },
    };
    models.__users.push(actor);
    await location(locationA, 'Outlet A');
    await location(locationB, 'Outlet B');
    await models.Settings.create({ lateGraceMinutes: 10 });
  });

  it('uses server time and rejects a second open clock-in', async () => {
    const worker = await employee('A-1', 'Alice', locationA, actorId);
    const before = Date.now();
    const first = await post('/api/payroll/attendance/clock-in', {
      clockIn: '2000-01-01T00:00:00.000Z',
    });
    const after = Date.now();
    expect(first.status).toBe(201);
    expect(new Date(first.body.record.clockIn).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(first.body.record.clockIn).getTime()).toBeLessThanOrEqual(after);
    expect(first.body.record).toMatchObject({
      source: 'self', late: false, unscheduled: true,
    });
    expect((await post('/api/payroll/attendance/clock-in')).status).toBe(409);

    const clockOut = await post('/api/payroll/attendance/clock-out');
    expect(clockOut.status).toBe(200);
    expect(clockOut.body.record.earlyLeave).toBe(false);
    expect(new Date(clockOut.body.record.clockOut).getTime()).toBeGreaterThanOrEqual(before);
  });

  it('flags clock-ins beyond grace and clock-outs before the rostered shift ends', async () => {
    const date = new Date(nextDate(nowDhakaDate()) - 2 * 86400000).toISOString().slice(0, 10);
    const worker = await employee('A-1B', 'Ayla', locationA);
    const workShift = await shift('Day shift', '09:00', '17:00', locationA);
    await roster(worker, workShift, date, locationA);
    const added = await post('/api/payroll/attendance/records', {
      employeeId: worker._id,
      date,
      clockIn: `${date}T03:12:00.000Z`,
      clockOut: `${date}T10:00:00.000Z`,
      locationId: locationA,
      reason: 'Signed attendance register',
    });
    expect(added.status).toBe(201);
    expect(added.body.record).toMatchObject({ late: true, earlyLeave: true, unscheduled: false });
  });

  it('flags a self clock-in without a roster entry as unscheduled', async () => {
    await employee('A-2', 'Bob', locationA, actorId);
    const clockedIn = await post('/api/payroll/attendance/clock-in');
    expect(clockedIn.status).toBe(201);
    expect(clockedIn.body.record).toMatchObject({
      late: false, earlyLeave: false, unscheduled: true,
    });
    expect(clockedIn.body.record).not.toHaveProperty('rosterEntryId');
  });
  it('lets a linked employee read only their own attendance without manager permission', async () => {
    const own = await employee('A-2B', 'Own employee', locationA, actorId);
    const other = await employee('A-2C', 'Coworker', locationA);
    actor.roleId.permissions = [];
    const date = nowDhakaDate();
    const workShift = await shift('Morning', '00:01', '23:59', locationA);
    const ownEntry = await roster(own, workShift, date, locationA);
    const otherEntry = await roster(other, workShift, date, locationA);
    await models.AttendanceRecord.create({
      employeeId: own._id, locationId: locationA, rosterEntryId: ownEntry._id,
      clockIn: new Date(), source: 'self', createdBy: actorId,
    });
    await models.AttendanceRecord.create({
      employeeId: other._id, locationId: locationA, rosterEntryId: otherEntry._id,
      clockIn: new Date(), source: 'self', createdBy: actorId,
    });

    const response = await request(app).get('/api/payroll/attendance')
      .query({ date }).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.employees.map((item) => item.employeeCode)).toEqual(['A-2B']);
    expect(response.body.rows).toHaveLength(1);
    expect(String(response.body.rows[0].employeeId)).toBe(String(own._id));
  });

  it('requires a correction reason and audits the old and new values', async () => {
    const worker = await employee('A-3', 'Cara', locationA);
    const initialClockIn = new Date(Date.now() - 3600000);
    const created = await post('/api/payroll/attendance/records', {
      employeeId: worker._id,
      date: nowDhakaDate(),
      clockIn: initialClockIn.toISOString(),
      clockOut: new Date(Date.now() - 1800000).toISOString(),
      locationId: locationA,
      reason: 'Paper attendance entry',
    });
    expect(created.status).toBe(201);
    const missingReason = await request(app).patch(
      `/api/payroll/attendance/records/${created.body.record._id}`,
    ).set(auth).send({ clockIn: new Date().toISOString() });
    expect(missingReason.status).toBe(400);

    const correctedClockIn = new Date(Date.now() - 2700000);
    const corrected = await request(app).patch(
      `/api/payroll/attendance/records/${created.body.record._id}`,
    ).set(auth).send({
      clockIn: correctedClockIn.toISOString(),
      reason: 'Corrected from signed register',
      locationId: locationA,
    });
    expect(corrected.status).toBe(200);
    expect(corrected.body.record.source).toBe('manager');
    expect(corrected.body.record.editReason).toBe('Corrected from signed register');
    const updateAudit = models.AuditLog.create.mock.calls
      .map(([item]) => item)
      .find((item) => item.action === 'UPDATE');
    expect(updateAudit.before.clockIn.getTime()).toBe(initialClockIn.getTime());
    expect(updateAudit.after.clockIn.getTime()).toBe(correctedClockIn.getTime());
  });
  it('locks managers to their own location for reads and manual entries', async () => {
    const own = await employee('A-4', 'Own outlet', locationA);
    const other = await employee('B-1', 'Other outlet', locationB);
    const blocked = await post('/api/payroll/attendance/records', {
      employeeId: other._id,
      date: nowDhakaDate(),
      clockIn: new Date().toISOString(),
      locationId: locationB,
      reason: 'Out of scope',
    });
    expect(blocked.status).toBe(400);

    const response = await request(app).get('/api/payroll/attendance')
      .query({ date: nowDhakaDate(), locationId: locationB.toString() }).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.employees.map((item) => item._id.toString())).toEqual([own._id.toString()]);
  });

  it('derives absence only after the shift ends', async () => {
    const date = nowDhakaDate();
    const tomorrow = new Date(nextDate(date)).toISOString().slice(0, 10);
    const worker = await employee('A-5', 'Dina', locationA);
    const workShift = await shift('Short', '00:01', '00:02', locationA);
    await roster(worker, workShift, date, locationA);
    await roster(worker, workShift, tomorrow, locationA);

    const todayResponse = await request(app).get('/api/payroll/attendance')
      .query({ date }).set(auth);
    const tomorrowResponse = await request(app).get('/api/payroll/attendance')
      .query({ date: tomorrow }).set(auth);
    expect(todayResponse.body.rows.map((row) => row.status)).toContain('Absent');
    expect(tomorrowResponse.body.rows).toHaveLength(0);
    expect(stores.AttendanceRecord).toHaveLength(0);
  });

  it('reports underlying monthly attendance counts and exports Excel and PDF', async () => {
    const date = nowDhakaDate();
    const worker = await employee('A-6', 'Eli', locationA);
    const workShift = await shift('Day', '00:01', '23:59', locationA);
    const entry = await roster(worker, workShift, date, locationA);
    const clockIn = new Date(Date.now() - 9 * 3600000);
    await models.AttendanceRecord.create({
      employeeId: worker._id,
      locationId: locationA,
      rosterEntryId: entry._id,
      clockIn,
      clockOut: new Date(clockIn.getTime() + 8 * 3600000),
      late: true,
      earlyLeave: false,
      unscheduled: false,
      source: 'self',
      createdBy: actorId,
    });

    const month = date.slice(0, 7);
    const response = await request(app).get('/api/reports/attendance')
      .query({ month, locationId: locationA.toString() }).set(auth);
    expect(response.status).toBe(200);
    expect(response.body.report.rows).toEqual([expect.objectContaining({
      employeeCode: 'A-6',
      rosteredShifts: 1,
      attended: 1,
      absent: 0,
      lateCount: 1,
      totalWorkedHours: 8,
    })]);

    const xlsx = await request(app).get('/api/reports/attendance')
      .query({ month, locationId: locationA.toString(), format: 'xlsx' })
      .set(auth).buffer(true).parse(parseBinary);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(xlsx.body);
    expect(workbook.worksheets[0].getRow(2).getCell(1).value).toBe('A-6');
    const pdf = await request(app).get('/api/reports/attendance')
      .query({ month, locationId: locationA.toString(), format: 'pdf' })
      .set(auth).buffer(true).parse(parseBinary);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString()).toBe('%PDF-');
  });
});
