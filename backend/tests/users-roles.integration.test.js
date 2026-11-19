const bcrypt = require('bcryptjs');
const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../models', () => ({
  AuditLog: { create: jest.fn() },
  Location: { findById: jest.fn() },
  Role: {
    create: jest.fn(),
    exists: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    findByIdAndDelete: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
  User: {
    create: jest.fn(),
    exists: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
    findByIdAndDelete: jest.fn(),
    findByIdAndUpdate: jest.fn(),
  },
}));

const {
  AuditLog, Location, Role, User,
} = require('../models');
const roleRoutes = require('../routes/roleRoutes');
const userRoutes = require('../routes/userRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');

const secret = 'users-roles-integration-test-secret';
const adminId = '65b000000000000000000001';
const roleId = '65b000000000000000000002';
const createdUserId = '65b000000000000000000003';
const locationId = '65b000000000000000000004';
const adminRole = { _id: roleId, name: 'Super Admin', permissions: ['*'] };
const admin = { _id: adminId, name: 'Admin User', email: 'admin@example.test', isActive: true, roleId: adminRole };
const role = { _id: roleId, name: 'Inventory Manager', permissions: ['products:read'] };

function chain(value) {
  const query = {
    select: () => query,
    populate: () => query,
    sort: () => query,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return query;
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/users', userRoutes);
  app.use('/api/roles', roleRoutes);
  app.use(errorMiddleware);
  return app;
}

function tokenFor(id = adminId) {
  return jwt.sign({ sub: id }, secret, { expiresIn: '1h' });
}

describe('users and roles endpoints', () => {
  const app = createApp();
  const auth = { Authorization: `Bearer ${tokenFor()}` };

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    jest.clearAllMocks();
    AuditLog.create.mockResolvedValue({});
    Location.findById.mockResolvedValue({ _id: locationId, name: 'Outlet', type: 'OUTLET', isActive: true });
    User.findById.mockImplementation((id) => ({
      populate: jest.fn().mockResolvedValue(id === adminId ? admin : {
        _id: createdUserId, name: 'Previous User', email: 'new@example.test', roleId: role,
        locationId, isActive: true,
      }),
    }));
    User.find.mockReturnValue(chain([]));
    Role.find.mockReturnValue(chain([]));
    Role.findById.mockResolvedValue(role);
    Role.exists.mockResolvedValue(role);
    User.exists.mockResolvedValue(null);
    User.create.mockResolvedValue({ _id: createdUserId, name: 'New User', email: 'new@example.test', roleId, isActive: true });
    User.findByIdAndUpdate.mockReturnValue({ populate: jest.fn().mockResolvedValue({
      _id: createdUserId, name: 'Updated User', email: 'new@example.test', roleId: role, locationId, isActive: true,
    }) });
    User.findByIdAndDelete.mockResolvedValue({ _id: createdUserId });
    Role.create.mockResolvedValue(role);
    Role.findByIdAndUpdate.mockResolvedValue(role);
    Role.findByIdAndDelete.mockResolvedValue(role);
  });

  it('lists users and roles without exposing password hashes', async () => {
    User.find.mockReturnValue(chain([
      { ...admin, roleId: adminRole, passwordHash: 'private' },
      { _id: createdUserId, name: 'Team User', roleId: role, locationId: { _id: locationId, name: 'Outlet', type: 'OUTLET' } },
    ]));
    Role.find.mockReturnValue(chain([role]));

    const users = await request(app).get('/api/users').set(auth);
    const roles = await request(app).get('/api/roles').set(auth);

    expect(users.status).toBe(200);
    expect(users.body.users[0]).toMatchObject({ id: adminId, role: 'Super Admin' });
    expect(users.body.users[0].passwordHash).toBeUndefined();
    expect(users.body.users[1]).toMatchObject({
      locationId, location: { id: locationId, name: 'Outlet', type: 'OUTLET' },
    });
    expect(roles.status).toBe(200);
    expect(roles.body.roles).toEqual([role]);
  });

  it('creates users with hashed passwords and records the audit event', async () => {
    const response = await request(app).post('/api/users').set(auth).send({
      name: 'New User', email: 'new@example.test', password: 'long-password', roleId, locationId,
    });

    expect(response.status).toBe(201);
    expect(response.body.user.passwordHash).toBeUndefined();
    const savedPassword = User.create.mock.calls[0][0].passwordHash;
    expect(await bcrypt.compare('long-password', savedPassword)).toBe(true);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', entity: 'User' }));
  });

  it('rejects users without locations on create and update', async () => {
    const response = await request(app).post('/api/users').set(auth).send({
      name: 'Test User', email: 'test2@example.test', password: 'long-password', roleId,
    });
    const updated = await request(app).put(`/api/users/${createdUserId}`).set(auth).send({
      name: 'Test User', email: 'test2@example.test', roleId, locationId: null,
    });
    expect(response.status).toBe(400);
    expect(updated.status).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('requires Super Admin accounts to have no location', async () => {
    Role.findById.mockResolvedValue(adminRole);
    const invalid = await request(app).post('/api/users').set(auth).send({
      name: 'Admin User', email: 'admin2@example.test', password: 'long-password', roleId, locationId,
    });
    expect(invalid.status).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
  });

  it('rejects a location incompatible with the role', async () => {
    Role.findById.mockResolvedValue({ ...role, allowedLocationType: 'warehouse' });
    const response = await request(app).post('/api/users').set(auth).send({
      name: 'Test User', email: 'test2@example.test', password: 'long-password', roleId, locationId,
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/does not match/);
    expect(User.create).not.toHaveBeenCalled();
    const updated = await request(app).put(`/api/users/${createdUserId}`).set(auth).send({
      name: 'Test User', email: 'test2@example.test', roleId,
    });
    expect(updated.status).toBe(400);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('updates and deletes users, auditing each write', async () => {
    const updated = await request(app).put(`/api/users/${createdUserId}`).set(auth).send({
      name: 'Updated User', email: 'new@example.test', roleId, isActive: true,
    });
    const removed = await request(app).delete(`/api/users/${createdUserId}`).set(auth);

    expect(updated.status).toBe(200);
    expect(updated.body.user.name).toBe('Updated User');
    expect(removed.status).toBe(200);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE', entity: 'User' }));
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE', entity: 'User' }));
  });

  it('stores and returns a user location assignment', async () => {
    User.create.mockResolvedValue({
      _id: createdUserId,
      name: 'Outlet User',
      email: 'outlet@example.test',
      roleId,
      locationId: '65b000000000000000000004',
      isActive: true,
    });
    const response = await request(app).post('/api/users').set(auth).send({
      name: 'Outlet User',
      email: 'outlet@example.test',
      password: 'long-password',
      roleId,
      locationId: '65b000000000000000000004',
    });

    expect(response.status).toBe(201);
    expect(User.create).toHaveBeenCalledWith(expect.objectContaining({
      locationId: '65b000000000000000000004',
    }));
    expect(response.body.user.locationId).toBe('65b000000000000000000004');
    expect(Location.findById).toHaveBeenCalledWith(locationId);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'User', action: 'CREATE', after: expect.objectContaining({ locationId }),
    }));
  });

  it('creates, updates, and deletes roles with audit records', async () => {
    const createPermissions = ['pos:read', 'shifts:manage', 'vendor-payouts:write'];
    const updatePermissions = ['products:read', 'settings:write'];
    const created = await request(app).post('/api/roles').set(auth).send({ name: 'Stock Viewer', permissions: createPermissions });
    const updated = await request(app).put(`/api/roles/${roleId}`).set(auth).send({ name: 'Inventory Team', permissions: updatePermissions });
    const removed = await request(app).delete(`/api/roles/${roleId}`).set(auth);

    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(removed.status).toBe(200);
    expect(Role.create).toHaveBeenCalledWith({
      name: 'Stock Viewer',
      permissions: ['dashboard:read', ...createPermissions],
      canViewAllLocations: false,
    });
    expect(Role.findByIdAndUpdate).toHaveBeenCalledWith(roleId, {
      name: 'Inventory Team', permissions: updatePermissions,
    }, { new: true, runValidators: true });
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'CREATE', entity: 'Role' }));
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'UPDATE', entity: 'Role' }));
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DELETE', entity: 'Role' }));
  });

  it('accepts shareholder write permission and always includes dashboard access on create', async () => {
    const response = await request(app).post('/api/roles').set(auth).send({
      name: 'Shareholder Manager',
      permissions: ['shareholders:read', 'shareholders:write'],
    });

    expect(response.status).toBe(201);
    expect(Role.create).toHaveBeenCalledWith({
      name: 'Shareholder Manager',
      permissions: ['dashboard:read', 'shareholders:read', 'shareholders:write'],
      canViewAllLocations: false,
    });
  });

  it('stores every page-level read/write flag and expands to route-guard permissions', async () => {
    const { granularPermissions } = require('../config/permissionCatalog');
    const response = await request(app).post('/api/roles').set(auth).send({
      name: 'Everything Pages', permissions: granularPermissions,
    });

    expect(response.status).toBe(201);
    const stored = Role.create.mock.calls[0][0].permissions;
    expect(granularPermissions).toHaveLength(76);
    expect(granularPermissions).toContain('reports.attendance:read');
    expect(granularPermissions).toContain('reports.attendance:write');
    expect(stored).toEqual(expect.arrayContaining(granularPermissions));
    expect(stored).toEqual(expect.arrayContaining(['stock:transfer:receive', 'vendor-payouts:write', 'payroll:write']));
  });

  it('rejects unknown and duplicate role permissions', async () => {
    const unknown = await request(app).post('/api/roles').set(auth).send({
      name: 'Unknown Access', permissions: ['system:root'],
    });
    const duplicate = await request(app).post('/api/roles').set(auth).send({
      name: 'Duplicate Access', permissions: ['stock:read', 'stock:read'],
    });

    expect(unknown.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(Role.create).not.toHaveBeenCalled();
  });

  it('rejects invalid input, unauthenticated access, and non-admin users', async () => {
    const missingAuth = await request(app).get('/api/users');
    const invalid = await request(app).post('/api/users').set(auth).send({ name: 'x' });
    User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
      ...admin, roleId: { name: 'Inventory Manager', permissions: ['*'] },
    }) });
    const forbidden = await request(app).get('/api/roles').set(auth);

    expect(missingAuth.status).toBe(401);
    expect(invalid.status).toBe(400);
    expect(User.create).not.toHaveBeenCalled();
    expect(forbidden.status).toBe(403);
  });

  it('does not let a non-admin change a user location', async () => {
    User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue({
      ...admin, roleId: { name: 'Team', permissions: ['roles:write'] }, locationId,
    }) });
    const response = await request(app).put(`/api/users/${createdUserId}`).set(auth).send({
      name: 'Test User', email: 'test@example.test', roleId, locationId,
    });
    expect(response.status).toBe(403);
    expect(User.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('validates and audits the role location type without changing omitted values', async () => {
    const invalid = await request(app).post('/api/roles').set(auth).send({
      name: 'Warehouse Team', permissions: [], allowedLocationType: 'invalid',
    });
    expect(invalid.status).toBe(400);
    Role.findByIdAndUpdate.mockResolvedValue({ ...role, allowedLocationType: 'warehouse' });
    const updated = await request(app).put(`/api/roles/${roleId}`).set(auth).send({
      name: 'Warehouse Team', permissions: [], allowedLocationType: 'warehouse',
    });
    expect(updated.status).toBe(200);
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'Role', before: expect.objectContaining({ allowedLocationType: 'any' }),
      after: expect.objectContaining({ allowedLocationType: 'warehouse' }),
    }));
  });

  it('validates, saves, and audits canViewAllLocations changes', async () => {
    const invalid = await request(app).post('/api/roles').set(auth).send({
      name: 'Invalid Location Viewer', permissions: [], canViewAllLocations: 'yes',
    });
    expect(invalid.status).toBe(400);

    Role.create.mockResolvedValue({ ...role, canViewAllLocations: true });
    const created = await request(app).post('/api/roles').set(auth).send({
      name: 'Location Viewer', permissions: [], canViewAllLocations: true,
    });
    expect(created.status).toBe(201);
    expect(Role.create).toHaveBeenCalledWith(expect.objectContaining({ canViewAllLocations: true }));
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'Role', action: 'CREATE', after: expect.objectContaining({ canViewAllLocations: true }),
    }));

    Role.findById.mockResolvedValue({ ...role, canViewAllLocations: false });
    Role.findByIdAndUpdate.mockResolvedValue({ ...role, canViewAllLocations: true });
    const updated = await request(app).put(`/api/roles/${roleId}`).set(auth).send({
      name: 'Location Viewer', permissions: [], canViewAllLocations: true,
    });
    expect(updated.status).toBe(200);
    expect(Role.findByIdAndUpdate).toHaveBeenCalledWith(roleId, expect.objectContaining({
      canViewAllLocations: true,
    }), { new: true, runValidators: true });
    expect(AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      entity: 'Role',
      action: 'UPDATE',
      before: expect.objectContaining({ canViewAllLocations: false }),
      after: expect.objectContaining({ canViewAllLocations: true }),
    }));

    Role.findById.mockResolvedValue({ ...role, canViewAllLocations: true });
    Role.findByIdAndUpdate.mockResolvedValue({ ...role, canViewAllLocations: true });
    const unchanged = await request(app).put(`/api/roles/${roleId}`).set(auth).send({
      name: 'Location Viewer', permissions: [],
    });
    expect(unchanged.status).toBe(200);
    expect(Role.findByIdAndUpdate.mock.calls[1][0]).not.toHaveProperty('canViewAllLocations');
  });

  it('protects the Super Admin role and prevents deleting assigned roles', async () => {
    Role.findById.mockResolvedValueOnce(adminRole).mockResolvedValueOnce(role);
    User.exists.mockResolvedValueOnce(true);
    const protectedRole = await request(app).delete(`/api/roles/${roleId}`).set(auth);
    const assignedRole = await request(app).delete(`/api/roles/${roleId}`).set(auth);

    expect(protectedRole.status).toBe(403);
    expect(assignedRole.status).toBe(409);
    expect(Role.findByIdAndDelete).not.toHaveBeenCalled();
  });
});