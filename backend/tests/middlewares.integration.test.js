const express = require('express');
const jwt = require('jsonwebtoken');
const request = require('supertest');

jest.mock('../models', () => ({
  User: { findById: jest.fn() },
}));

const { User } = require('../models');
const authMiddleware = require('../middlewares/authMiddleware');
const authorizeMiddleware = require('../middlewares/authorizeMiddleware');
const enforceLocationScope = require('../middlewares/enforceLocationScope');
const errorMiddleware = require('../middlewares/errorMiddleware');
const validateRequest = require('../middlewares/validateRequest');
const { body } = require('express-validator');

const secret = 'integration-test-secret-that-is-long-enough';
const userId = '65b000000000000000000001';

function createApp() {
  const app = express();
  app.use(express.json());
  app.get('/protected', authMiddleware, authorizeMiddleware({
    roles: ['Inventory Manager'],
    permissions: ['products:read'],
  }), (req, res) => res.json({ user: req.user.id }));
  app.get('/one-permission', authMiddleware, authorizeMiddleware({
    anyPermissions: ['stock:read', 'stock:transfer:read'],
  }), (req, res) => res.json({ user: req.user.id }));
  app.post('/scope/:locationId/:outletId/:warehouseId', authMiddleware, enforceLocationScope, (req, res) => {
    res.json({ locationId: req.locationId, query: req.query, body: req.body, params: req.params });
  });
  app.post('/validated', body('name').isString().notEmpty(), validateRequest, (req, res) => {
    res.json({ name: req.body.name });
  });
  app.get('/failure', (req, res, next) => {
    const error = new Error('Expected failure');
    error.status = 422;
    next(error);
  });
  app.get('/internal', (req, res, next) => next(new Error('Sensitive internal detail')));
  app.use(errorMiddleware);
  return app;
}

function setUser(user) {
  User.findById.mockReturnValue({ populate: jest.fn().mockResolvedValue(user) });
}

function tokenFor(id = userId) {
  return jwt.sign({ sub: id }, secret, { expiresIn: '1h' });
}

describe('middleware integration', () => {
  const app = createApp();

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    User.findById.mockReset();
  });

  it('authenticates a bearer token and loads the current role permissions', async () => {
    setUser({
      _id: { toString: () => userId },
      name: 'Inventory User',
      email: 'inventory@example.test',
      isActive: true,
      roleId: { _id: '65b000000000000000000002', name: 'Inventory Manager', permissions: ['products:read'] },
    });

    const response = await request(app).get('/protected').set('Authorization', `Bearer ${tokenFor()}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ user: userId });
    expect(User.findById).toHaveBeenCalledWith(userId);
  });

  it('rejects missing tokens and inactive users', async () => {
    const missingToken = await request(app).get('/protected');
    setUser({ _id: { toString: () => userId }, isActive: false });
    const inactiveUser = await request(app).get('/protected').set('Authorization', `Bearer ${tokenFor()}`);

    expect(missingToken.status).toBe(401);
    expect(missingToken.body).toMatchObject({ success: false, message: 'Authentication required' });
    expect(inactiveUser.status).toBe(401);
  });

  it('rejects users without required roles or permissions and allows wildcard permissions', async () => {
    setUser({
      _id: { toString: () => userId },
      isActive: true,
      roleId: { name: 'Warehouse Staff', permissions: ['products:read'] },
    });
    const wrongRole = await request(app).get('/protected').set('Authorization', `Bearer ${tokenFor()}`);

    setUser({
      _id: { toString: () => userId },
      isActive: true,
      roleId: { name: 'Inventory Manager', permissions: [] },
    });
    const missingPermission = await request(app).get('/protected').set('Authorization', `Bearer ${tokenFor()}`);

    setUser({
      _id: { toString: () => userId },
      isActive: true,
      roleId: { name: 'Inventory Manager', permissions: ['*'] },
    });
    const wildcardPermission = await request(app).get('/protected').set('Authorization', `Bearer ${tokenFor()}`);

    expect(wrongRole.status).toBe(403);
    expect(missingPermission.status).toBe(403);
    expect(wildcardPermission.status).toBe(200);
  });

  it('allows any configured permission while rejecting users with none', async () => {
    setUser({
      _id: { toString: () => userId },
      isActive: true,
      roleId: { name: 'Outlet Cashier', permissions: ['stock:transfer:read'] },
    });
    const allowed = await request(app).get('/one-permission')
      .set({ Authorization: `Bearer ${tokenFor()}` });
    setUser({
      _id: { toString: () => userId },
      isActive: true,
      roleId: { name: 'Finance', permissions: ['finance:read'] },
    });
    const denied = await request(app).get('/one-permission')
      .set({ Authorization: `Bearer ${tokenFor()}` });
    expect(allowed.status).toBe(200);
    expect(denied.status).toBe(403);
  });

  it('overwrites location fields for a locked user and fails closed without an assignment', async () => {
    const assigned = '65b000000000000000000003';
    const other = '65b000000000000000000004';
    const user = { _id: userId, isActive: true, roleId: { name: 'Team', permissions: [] }, locationId: assigned };
    setUser(user);
    const response = await request(app).post(`/scope/${other}/${other}/${other}`)
      .query({ locationId: other, outletId: other, warehouseId: other, selectedOutletId: other })
      .set('Authorization', `Bearer ${tokenFor()}`)
      .send({ locationId: other, outletId: other, warehouseId: other });
    expect(response.status).toBe(200);
    expect(response.body.locationId).toBe(assigned);
    for (const source of [response.body.query, response.body.body, response.body.params]) {
      expect(source).toMatchObject({ locationId: assigned, outletId: assigned, warehouseId: assigned });
    }
    setUser({ ...user, locationId: null });
    expect((await request(app).post(`/scope/${other}/${other}/${other}`)
      .set('Authorization', `Bearer ${tokenFor()}`)).status).toBe(403);
  });

  it('lets Super Admin select any location or all locations', async () => {
    const selected = '65b000000000000000000004';
    setUser({ _id: userId, isActive: true, locationId: 'legacy', roleId: { name: 'Super Admin', permissions: ['*'] } });
    const selectedResponse = await request(app).post(`/scope/${selected}/${selected}/${selected}`)
      .query({ selectedOutletId: selected }).set('Authorization', `Bearer ${tokenFor()}`);
    const allResponse = await request(app).post(`/scope/${selected}/${selected}/${selected}`)
      .set('Authorization', `Bearer ${tokenFor()}`);
    expect(selectedResponse.body.locationId).toBe(selected);
    expect(allResponse.body.locationId).toBeNull();
  });

  it('returns validation errors and consistent central error responses', async () => {
    const validationResponse = await request(app).post('/validated').send({ name: '' });
    const errorResponse = await request(app).get('/failure');
    const internalResponse = await request(app).get('/internal');

    expect(validationResponse.status).toBe(400);
    expect(validationResponse.body).toMatchObject({
      success: false,
      message: 'Request validation failed',
      errors: [{ field: 'name' }],
    });
    expect(errorResponse.status).toBe(422);
    expect(errorResponse.body).toEqual({ success: false, message: 'Expected failure', errors: [] });
    expect(internalResponse.status).toBe(500);
    expect(internalResponse.body).toEqual({ success: false, message: 'Internal server error', errors: [] });
  });
});