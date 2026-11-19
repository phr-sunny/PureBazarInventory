const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

jest.mock('../models', () => {
  const { fakeModel } = require('./helpers/fakeModel');
  const actual = {
    Employee: jest.requireActual('../models/Employee'),
    Location: jest.requireActual('../models/Location'),
    RosterEntry: jest.requireActual('../models/RosterEntry'),
    WorkShift: jest.requireActual('../models/WorkShift'),
  };
  const stores = {};
  const mocked = { AuditLog: { create: jest.fn() }, __stores: stores, __users: [] };
  Object.entries(actual).forEach(([name, Real]) => {
    stores[name] = [];
    mocked[name] = fakeModel(Real, stores[name]);
  });
  mocked.User = {
    findById(id) {
      const user = mocked.__users.find((item) => String(item._id) === String(id)) || null;
      const result = Promise.resolve(user);
      return {
        populate: async () => user,
        then: (resolve, reject) => result.then(resolve, reject),
      };
    },
  };
  const findLocation = mocked.Location.findById;
  mocked.Location.findById = (id) => {
    const result = findLocation(id);
    const query = {
      select: () => query,
      lean: () => result,
      then: (resolve, reject) => result.then(resolve, reject),
    };
    return query;
  };
  return mocked;
});

const models = require('../models');
const payrollRoutes = require('../routes/payrollRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');

const secret = 'work-roster-test-secret';
const actorId = new mongoose.Types.ObjectId('65e000000000000000000001');
const locationA = new mongoose.Types.ObjectId('65e000000000000000000002');
const locationB = new mongoose.Types.ObjectId('65e000000000000000000003');
const app = express();
app.use(express.json());
app.use('/api/payroll', payrollRoutes);
app.use(errorMiddleware);

describe('work shifts and roster API', () => {
  let actor;
  const stores = models.__stores;
  const token = () => jwt.sign({ sub: actorId.toString() }, secret);
  const auth = { get Authorization() { return `Bearer ${token()}`; } };
  const post = (url, body) => request(app).post(url).set(auth).send(body);

  async function location(id, name) {
    return models.Location.create({ _id: id, type: 'OUTLET', name, isActive: true });
  }

  async function employee(code, name, locationId, userId) {
    return models.Employee.create({
      employeeCode: code, name, baseSalary: 100, status: 'ACTIVE', locationId, userId,
    });
  }

  async function shift(name, startTime, endTime, locationId) {
    return models.WorkShift.create({ name, startTime, endTime, locationId, isActive: true });
  }

  beforeEach(async () => {
    process.env.JWT_SECRET = secret;
    Object.values(stores).forEach((store) => { store.length = 0; });
    models.__users.length = 0;
    models.AuditLog.create.mockReset().mockResolvedValue({});
    actor = {
      _id: actorId,
      name: 'Roster Manager',
      email: 'manager@example.test',
      isActive: true,
      locationId: { _id: locationA, name: 'Outlet A', type: 'OUTLET' },
      roleId: {
        _id: actorId,
        name: 'Outlet Manager',
        permissions: [
          'employees:read', 'employees:write',
          'hr.work-shifts:read', 'hr.work-shifts:write',
          'hr.shift-roster:read', 'hr.shift-roster:write',
        ],
        canViewAllLocations: false,
      },
    };
    models.__users.push(actor);
    await location(locationA, 'Outlet A');
    await location(locationB, 'Outlet B');
  });

  it('rejects overlapping assignments and duplicate employee/date/shift assignments', async () => {
    const worker = await employee('E-1', 'Alice', locationA);
    const morning = await shift('Morning', '09:00', '12:00', locationA);
    const overlap = await shift('Overlap', '11:30', '14:00', locationA);
    const first = await post('/api/payroll/roster', {
      employeeId: worker._id, workShiftId: morning._id, date: '2099-05-04', locationId: locationA,
    });
    expect(first.status).toBe(201);
    const duplicate = await post('/api/payroll/roster', {
      employeeId: worker._id, workShiftId: morning._id, date: '2099-05-04', locationId: locationA,
    });
    expect(duplicate.status).toBe(409);
    const conflicting = await post('/api/payroll/roster', {
      employeeId: worker._id, workShiftId: overlap._id, date: '2099-05-04', locationId: locationA,
    });
    expect(conflicting.status).toBe(409);
    expect(stores.RosterEntry).toHaveLength(1);
  });

  it('creates outlet work shifts, validates times, and audits changes', async () => {
    const created = await post('/api/payroll/work-shifts', {
      name: 'Day', startTime: '09:00', endTime: '17:00', locationId: locationA,
    });
    expect(created.status).toBe(201);
    const updated = await request(app).patch(`/api/payroll/work-shifts/${created.body.workShift._id}`)
      .set(auth).send({ startTime: '10:00', endTime: '18:00', locationId: locationA });
    expect(updated.status).toBe(200);
    const duplicate = await post('/api/payroll/work-shifts', {
      name: 'Day', startTime: '08:00', endTime: '16:00', locationId: locationA,
    });
    expect(duplicate.status).toBe(409);
    const invalid = await post('/api/payroll/work-shifts', {
      name: 'Invalid', startTime: '17:00', endTime: '09:00', locationId: locationA,
    });
    expect(invalid.status).toBe(400);
    expect(models.AuditLog.create.mock.calls.map(([log]) => `${log.entity}:${log.action}`)).toEqual([
      'WorkShift:CREATE', 'WorkShift:UPDATE',
    ]);
  });

  it('keeps a location-locked user from reading or writing another outlet roster', async () => {
    const ownEmployee = await employee('E-1', 'Alice', locationA);
    const otherEmployee = await employee('E-2', 'Bob', locationB);
    const ownShift = await shift('Own shift', '09:00', '12:00', locationA);
    const otherShift = await shift('Other shift', '13:00', '17:00', locationB);
    await models.RosterEntry.create({
      employeeId: ownEmployee._id, workShiftId: ownShift._id, date: new Date('2026-03-02T00:00:00.000Z'),
      locationId: locationA, createdBy: actorId,
    });
    await models.RosterEntry.create({
      employeeId: otherEmployee._id, workShiftId: otherShift._id, date: new Date('2026-03-02T00:00:00.000Z'),
      locationId: locationB, createdBy: actorId,
    });

    const read = await request(app).get('/api/payroll/roster')
      .query({ weekStart: '2026-03-02', locationId: locationB.toString() }).set(auth);
    expect(read.status).toBe(200);
    expect(read.body.entries).toHaveLength(1);
    expect(String(read.body.entries[0].locationId)).toBe(String(locationA));

    const write = await post('/api/payroll/roster', {
      employeeId: otherEmployee._id, workShiftId: otherShift._id, date: '2026-03-03', locationId: locationB,
    });
    expect(write.status).toBe(400);
    expect(stores.RosterEntry).toHaveLength(2);
  });

  it('lets canViewAllLocations users read other outlets but only Super Admin can write there', async () => {
    const otherEmployee = await employee('E-2', 'Bob', locationB);
    const otherShift = await shift('Other shift', '13:00', '17:00', locationB);
    actor.roleId.canViewAllLocations = true;
    await models.RosterEntry.create({
      employeeId: otherEmployee._id, workShiftId: otherShift._id, date: new Date('2026-03-02T00:00:00.000Z'),
      locationId: locationB, createdBy: actorId,
    });

    const read = await request(app).get('/api/payroll/roster')
      .query({ weekStart: '2026-03-02', locationId: locationB.toString() }).set(auth);
    expect(read.status).toBe(200);
    expect(read.body.entries).toHaveLength(1);
    const forbiddenWrite = await post('/api/payroll/roster', {
      employeeId: otherEmployee._id, workShiftId: otherShift._id, date: '2026-03-03', locationId: locationB,
    });
    expect(forbiddenWrite.status).toBe(400);

    actor.roleId.name = 'Super Admin';
    actor.locationId = null;
    const allowedWrite = await post('/api/payroll/roster', {
      employeeId: otherEmployee._id, workShiftId: otherShift._id, date: '2026-03-03', locationId: locationB,
    });
    expect(allowedWrite.status).toBe(201);
  });

  it('limits a linked employee to their own upcoming shifts', async () => {
    const ownEmployee = await employee('E-1', 'Alice', locationA, actorId);
    const otherEmployee = await employee('E-2', 'Bob', locationA);
    const workShift = await shift('Evening', '16:00', '20:00', locationA);
    await models.RosterEntry.create({
      employeeId: ownEmployee._id, workShiftId: workShift._id, date: new Date('2099-05-04T00:00:00.000Z'),
      locationId: locationA, createdBy: actorId,
    });
    await models.RosterEntry.create({
      employeeId: otherEmployee._id, workShiftId: workShift._id, date: new Date('2099-05-04T00:00:00.000Z'),
      locationId: locationA, createdBy: actorId,
    });
    actor.roleId.permissions = ['hr.shift-roster:read'];

    const read = await request(app).get('/api/payroll/roster')
      .query({ weekStart: '2099-05-04', locationId: locationA }).set(auth);
    expect(read.status).toBe(200);
    expect(read.body.employees.map((item) => item.name)).toEqual(['Alice']);
    expect(read.body.entries).toHaveLength(1);

    const mine = await request(app).get('/api/payroll/my-roster').set(auth);
    expect(mine.status).toBe(200);
    expect(mine.body.employee.name).toBe('Alice');
    expect(mine.body.entries).toHaveLength(1);
    expect(String(mine.body.entries[0].employeeId)).toBe(String(ownEmployee._id));
  });

  it('copies last week assignments into the selected week and audits the writes', async () => {
    const worker = await employee('E-1', 'Alice', locationA);
    const workShift = await shift('Morning', '09:00', '12:00', locationA);
    await models.RosterEntry.create({
      employeeId: worker._id, workShiftId: workShift._id, date: new Date('2099-04-27T00:00:00.000Z'),
      locationId: locationA, notes: 'Opening', createdBy: actorId,
    });

    const copied = await post('/api/payroll/roster/copy-last-week', {
      weekStart: '2099-05-04', locationId: locationA,
    });
    expect(copied.status).toBe(201);
    expect(copied.body.copied).toBe(1);
    expect(stores.RosterEntry).toHaveLength(2);
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorId, action: 'CREATE', entity: 'RosterEntry',
    }));
  });

  it('requires an employee login link to share the employee outlet', async () => {
    const good = await post('/api/payroll/employees', {
      employeeCode: 'E-1', name: 'Alice', baseSalary: 100, userId: actorId, locationId: locationA,
      employmentType: 'part-time', isStudent: true, notes: 'Evenings only',
    });
    expect(good.status).toBe(201);
    expect(good.body.employee).toMatchObject({
      employmentType: 'part-time', isStudent: true, notes: 'Evenings only',
    });
    const wrongOutlet = await post('/api/payroll/employees', {
      employeeCode: 'E-2', name: 'Bob', baseSalary: 100, userId: actorId, locationId: locationB,
    });
    expect(wrongOutlet.status).toBe(400);
  });
});
