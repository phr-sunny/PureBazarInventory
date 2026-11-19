const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

jest.mock('../models', () => ({
  AuditLog: { create: jest.fn() },
  Location: { find: jest.fn(), findById: jest.fn() },
  Product: { find: jest.fn() },
  Settings: { findOne: jest.fn() },
  StockAdjustment: { create: jest.fn(), find: jest.fn(), findById: jest.fn() },
  StockCount: { create: jest.fn(), find: jest.fn(), findById: jest.fn() },
  StockMovement: { aggregate: jest.fn(), create: jest.fn() },
  User: { findById: jest.fn() },
}));

const {
  AuditLog, Location, Product, Settings, StockAdjustment, StockCount, StockMovement, User,
} = require('../models');
const stockRoutes = require('../routes/stockRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');
const { canManageLocation, hasGlobalStockAccess } = require('../utils/stockAdjustments');

const secret = 'stock-adjustment-integration-test-secret';
const ids = {
  warehouse: '65b000000000000000000001',
  outlet: '65b000000000000000000005',
  otherOutlet: '65b000000000000000000006',
  manager: '65b000000000000000000002',
  admin: '65b000000000000000000003',
  product: '65b000000000000000000004',
};
const locations = new Map([
  [ids.warehouse, { _id: new mongoose.Types.ObjectId(ids.warehouse), type: 'CENTRAL', name: 'Central Warehouse', isActive: true }],
  [ids.outlet, { _id: new mongoose.Types.ObjectId(ids.outlet), type: 'OUTLET', name: 'Outlet One', isActive: true }],
  [ids.otherOutlet, { _id: new mongoose.Types.ObjectId(ids.otherOutlet), type: 'OUTLET', name: 'Outlet Two', isActive: true }],
]);
const product = {
  _id: new mongoose.Types.ObjectId(ids.product),
  name: 'Sample Product',
  sku: 'SAMPLE-001',
  barcode: '1234567890123',
  vendorPrice: 20,
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function query(value) {
  const result = {
    select: jest.fn(() => result),
    sort: jest.fn(() => result),
    limit: jest.fn(() => result),
    session: jest.fn(() => result),
    lean: jest.fn(() => Promise.resolve(value)),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return result;
}

function document(data) {
  return {
    ...data,
    _id: data._id || new mongoose.Types.ObjectId(),
    toObject() { return clone({ ...this, toObject: undefined, save: undefined }); },
    async save() {},
  };
}

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', stockRoutes);
  app.use(errorMiddleware);
  return app;
}

describe('stock adjustment and count API', () => {
  const app = createApp();
  let user;
  let movements;
  let adjustments;
  let counts;
  let auditLogs;

  function auth(userId = ids.manager) {
    return { Authorization: `Bearer ${jwt.sign({ sub: userId }, secret)}` };
  }

  function stockAt(warehouseId, productId) {
    return movements.filter((movement) => (
      movement.warehouseId.toString() === warehouseId
      && movement.productId.toString() === productId
    )).reduce((total, movement) => total + movement.quantity, 0);
  }

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    jest.clearAllMocks();
    user = {
      _id: new mongoose.Types.ObjectId(ids.manager),
      isActive: true,
      locationId: { ...locations.get(ids.warehouse), _id: new mongoose.Types.ObjectId(ids.warehouse) },
      roleId: { name: 'Inventory Manager', permissions: ['stock:read', 'stock:write'] },
    };
    movements = [{
      productId: new mongoose.Types.ObjectId(ids.product),
      warehouseId: new mongoose.Types.ObjectId(ids.warehouse),
      quantity: 10,
      type: 'GRN',
    }];
    adjustments = new Map();
    counts = new Map();
    auditLogs = [];
    const session = {
      withTransaction: jest.fn(async (callback) => callback()),
      endSession: jest.fn(),
    };
    jest.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    User.findById.mockReturnValue({ populate: jest.fn().mockImplementation(async () => user) });
    Location.find.mockReturnValue({
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue([...locations.values()]),
      })),
    });
    Location.findById.mockImplementation((id) => query(locations.get(id.toString()) || null));
    Product.find.mockImplementation((filter = {}) => query(
      filter._id?.$in
        ? [product].filter(({ _id }) => filter._id.$in.some((id) => id.toString() === _id.toString()))
        : [product],
    ));
    Settings.findOne.mockReturnValue(query({ stockAdjustmentApprovalLimit: 100 }));
    AuditLog.create.mockImplementation(async (logs) => { auditLogs.push(...logs); return logs; });
    StockMovement.aggregate.mockImplementation((pipeline) => {
      const filter = pipeline[0].$match;
      if (!filter.productId) {
        const stock = new Map();
        movements.filter((movement) => movement.warehouseId.toString() === filter.warehouseId.toString())
          .forEach((movement) => {
            const id = movement.productId.toString();
            stock.set(id, (stock.get(id) || 0) + movement.quantity);
          });
        return [...stock].map(([id, quantity]) => ({ _id: new mongoose.Types.ObjectId(id), quantity }));
      }
      return {
        session: jest.fn(async () => {
        const productIds = filter.productId.$in.filter((id) => id instanceof mongoose.Types.ObjectId);
        const stock = new Map();
        movements.filter((movement) => (
          movement.warehouseId.toString() === filter.warehouseId.toString()
          && productIds.some((id) => id.equals(movement.productId))
        )).forEach((movement) => {
          const id = movement.productId.toString();
          stock.set(id, (stock.get(id) || 0) + movement.quantity);
        });
        return [...stock].map(([id, quantity]) => ({ _id: new mongoose.Types.ObjectId(id), quantity }));
        }),
      };
    });
    StockMovement.create.mockImplementation(async (docs) => { movements.push(...docs); return docs; });
    StockAdjustment.create.mockImplementation(async ([data]) => {
      const item = document({ status: 'Pending', ...data });
      adjustments.set(item._id.toString(), item);
      return [item];
    });
    StockAdjustment.findById.mockImplementation((id) => query(adjustments.get(id.toString()) || null));
    StockAdjustment.find.mockImplementation((filter = {}) => ({
      sort: jest.fn(() => query([...adjustments.values()].filter((item) => (
        (!filter.warehouseId || item.warehouseId.toString() === filter.warehouseId.toString())
        && (!filter.status || item.status === filter.status)
      )))),
    }));
    StockCount.create.mockImplementation(async ([data]) => {
      const item = document(data);
      counts.set(item._id.toString(), item);
      return [item];
    });
    StockCount.findById.mockImplementation((id) => query(counts.get(id.toString()) || null));
    StockCount.find.mockImplementation((filter = {}) => ({
      sort: jest.fn(() => query([...counts.values()].filter((item) => {
        const warehouseFilter = filter.warehouseId;
        const matchesWarehouse = !warehouseFilter
          || (warehouseFilter.$in
            ? warehouseFilter.$in.some((id) => id.toString() === item.warehouseId.toString())
            : item.warehouseId.toString() === warehouseFilter.toString());
        return matchesWarehouse && (!filter.status || item.status === filter.status);
      }))),
    }));
  });

  afterEach(() => jest.restoreAllMocks());

  it('keeps outlet adjustments and counts at the assigned location despite client location overrides', async () => {
    user.locationId = { ...locations.get(ids.outlet), _id: new mongoose.Types.ObjectId(ids.outlet) };
    const adjustment = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.otherOutlet, mode: 'ADD', reason: 'Found extra stock',
      lines: [{ productId: ids.product, quantity: 1 }],
    });

    const count = await request(app).post('/api/stock-counts').set(auth()).send({
      warehouseId: ids.otherOutlet, reason: 'Stock check',
      lines: [{ productId: ids.product, countedQuantity: 1 }],
    });
    expect(adjustment.status).toBe(201);
    expect(adjustment.body.stockAdjustment.warehouseId.toString()).toBe(ids.outlet);
    expect(count.status).toBe(201);
    expect(count.body.stockCount.warehouseId.toString()).toBe(ids.outlet);
    expect(stockAt(ids.otherOutlet, ids.product)).toBe(0);

    counts.set(new mongoose.Types.ObjectId().toString(), document({
      warehouseId: new mongoose.Types.ObjectId(ids.otherOutlet),
      reason: 'Other outlet',
      status: 'Posted',
      lines: [],
    }));
    const outletCounts = await request(app).get('/api/stock-counts')
      .set(auth()).query({ warehouseId: ids.otherOutlet });
    const outletStock = await request(app).get('/api/stock')
      .set(auth()).query({ warehouseId: ids.otherOutlet });
    expect(outletCounts.body.stockCounts.map((item) => item.warehouseId.toString()))
      .toEqual([ids.outlet]);
    expect(outletStock.body.warehouseId).toBe(ids.outlet);
  });

  it('keeps central stock adjustments at the assigned warehouse when an outlet is submitted', async () => {
    const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.outlet,
      mode: 'ADD',
      reason: 'Found extra stock',
      lines: [{ productId: ids.product, quantity: 1 }],
    });
    expect(response.status).toBe(201);
    expect(response.body.stockAdjustment.warehouseId.toString()).toBe(ids.warehouse);
    expect(stockAt(ids.warehouse, ids.product)).toBe(11);
    expect(stockAt(ids.outlet, ids.product)).toBe(0);
  });

  it('allows a central user to count an outlet and posts the difference at that outlet', async () => {
    movements = [{
      productId: new mongoose.Types.ObjectId(ids.product),
      warehouseId: new mongoose.Types.ObjectId(ids.outlet),
      quantity: 100,
      type: 'GRN',
    }];
    const created = await request(app).post('/api/stock-counts').set(auth()).send({
      warehouseId: ids.outlet,
      reason: 'Outlet stock count',
      lines: [{ productId: ids.product, countedQuantity: 90 }],
    });

    expect(created.status).toBe(201);
    expect(created.body.stockCount.lines[0].expectedQuantity).toBe(100);

    Settings.findOne.mockReturnValue(query({ stockAdjustmentApprovalLimit: 1000 }));
    const posted = await request(app).post(`/api/stock-counts/${created.body.stockCount._id}/post`).set(auth());
    expect(posted.status).toBe(200);
    expect(stockAt(ids.outlet, ids.product)).toBe(90);
    expect(stockAt(ids.warehouse, ids.product)).toBe(0);
    expect(movements.at(-1).warehouseId.toString()).toBe(ids.outlet);
    expect(movements.at(-1)).toMatchObject({ type: 'ADJUSTMENT', quantity: -10 });
    const postLog = auditLogs.find((entry) => entry.entity === 'StockCount' && entry.action === 'POST');
    expect(postLog.metadata.warehouseId.toString()).toBe(ids.outlet);
    expect(postLog.metadata.postedBy.toString()).toBe(ids.manager);

    user.locationId = { ...locations.get(ids.outlet), _id: new mongoose.Types.ObjectId(ids.outlet) };
    const outletRegister = await request(app).get('/api/stock-counts').set(auth());
    expect(outletRegister.body.stockCounts.map((count) => count._id.toString()))
      .toContain(created.body.stockCount._id);
  });

  it('returns every catalog product with location-specific movement stock', async () => {
    movements = [
      {
        productId: new mongoose.Types.ObjectId(ids.product),
        warehouseId: new mongoose.Types.ObjectId(ids.outlet),
        quantity: 100,
        type: 'GRN',
      },
      {
        productId: new mongoose.Types.ObjectId(ids.product),
        warehouseId: new mongoose.Types.ObjectId(ids.outlet),
        quantity: -10,
        type: 'SALE',
      },
    ];
    const outlet = await request(app).get('/api/inventory/outlet-products')
      .set(auth()).query({ warehouseId: ids.outlet });
    const stockView = await request(app).get('/api/stock')
      .set(auth()).query({ warehouseId: ids.outlet });
    const central = await request(app).get('/api/inventory/outlet-products')
      .set(auth()).query({ warehouseId: ids.warehouse });

    expect(outlet.status).toBe(200);
    expect(outlet.body.products).toMatchObject([{
      productId: ids.product, name: 'Sample Product', sku: 'SAMPLE-001', barcode: '1234567890123', stock: 90,
    }]);
    expect(stockView.body.stock).toMatchObject([{ quantity: 90 }]);
    expect(central.status).toBe(200);
    expect(central.body.products).toMatchObject([{ productId: ids.product, stock: 0 }]);
  });

  it('requires stock write permission to create or post any stock count', async () => {
    user.roleId.permissions = ['stock:read'];
    const created = await request(app).post('/api/stock-counts').set(auth()).send({
      warehouseId: ids.outlet,
      reason: 'Not permitted',
      lines: [{ productId: ids.product, countedQuantity: 1 }],
    });
    expect(created.status).toBe(403);
    const posted = await request(app).post(`/api/stock-counts/${ids.product}/post`).set(auth());
    expect(posted.status).toBe(403);
    expect(counts.size).toBe(0);
  });

  it('lets an all-location reader select other registers but keeps adjustment and count writes locked', async () => {
    const remoteAdjustment = document({
      warehouseId: new mongoose.Types.ObjectId(ids.otherOutlet),
      reason: 'Remote adjustment',
      status: 'Pending',
      lines: [{ productId: new mongoose.Types.ObjectId(ids.product), quantity: 1 }],
    });
    const remoteCount = document({
      warehouseId: new mongoose.Types.ObjectId(ids.otherOutlet),
      reason: 'Remote count',
      status: 'Counting',
      lines: [{ productId: new mongoose.Types.ObjectId(ids.product), countedQuantity: 1 }],
    });
    adjustments.set(remoteAdjustment._id.toString(), remoteAdjustment);
    counts.set(remoteCount._id.toString(), remoteCount);
    user = {
      ...user,
      locationId: { ...locations.get(ids.outlet), _id: new mongoose.Types.ObjectId(ids.outlet) },
      roleId: {
        name: 'Deputy',
        permissions: ['stock:read', 'stock:write'],
        canViewAllLocations: true,
      },
    };

    const adjustmentRead = await request(app).get('/api/stock-adjustments')
      .query({ selectedOutletId: ids.otherOutlet }).set(auth());
    const adjustmentAll = await request(app).get('/api/stock-adjustments?selectedOutletId=').set(auth());
    const countRead = await request(app).get('/api/stock-counts')
      .query({ selectedOutletId: ids.otherOutlet }).set(auth());
    const countAll = await request(app).get('/api/stock-counts?warehouseId=').set(auth());
    const adjustmentWrite = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.otherOutlet,
      mode: 'ADD',
      reason: 'Found extra stock',
      lines: [{ productId: ids.product, quantity: 1 }],
    });
    const countWrite = await request(app).post('/api/stock-counts').set(auth()).send({
      warehouseId: ids.otherOutlet,
      reason: 'Locked count',
      lines: [{ productId: ids.product, countedQuantity: 1 }],
    });
    const approveRemote = await request(app)
      .post(`/api/stock-adjustments/${remoteAdjustment._id}/approve`).set(auth());
    const postRemote = await request(app)
      .post(`/api/stock-counts/${remoteCount._id}/post`).set(auth());

    expect(adjustmentRead.status).toBe(200);
    expect(adjustmentRead.body.stockAdjustments.map((item) => item.warehouseId.toString()))
      .toEqual([ids.otherOutlet]);
    expect(adjustmentAll.status).toBe(200);
    expect(adjustmentAll.body.stockAdjustments).toHaveLength(1);
    expect(countRead.status).toBe(200);
    expect(countRead.body.stockCounts.map((item) => item.warehouseId.toString()))
      .toEqual([ids.otherOutlet]);
    expect(countAll.status).toBe(200);
    expect(countAll.body.stockCounts).toHaveLength(1);
    expect(adjustmentWrite.status).toBe(201);
    expect(adjustmentWrite.body.stockAdjustment.warehouseId.toString()).toBe(ids.outlet);
    expect(countWrite.status).toBe(201);
    expect(countWrite.body.stockCount.warehouseId.toString()).toBe(ids.outlet);
    expect(approveRemote.status).toBe(403);
    expect(postRemote.status).toBe(403);
  });

  it('keeps adjustment and count reads at the assigned central warehouse without the role setting', async () => {
    const remoteAdjustment = document({
      warehouseId: new mongoose.Types.ObjectId(ids.otherOutlet),
      reason: 'Remote adjustment',
      status: 'Approved',
      lines: [],
    });
    const remoteCount = document({
      warehouseId: new mongoose.Types.ObjectId(ids.otherOutlet),
      reason: 'Remote count',
      status: 'Posted',
      lines: [],
    });
    adjustments.set(remoteAdjustment._id.toString(), remoteAdjustment);
    counts.set(remoteCount._id.toString(), remoteCount);

    const adjustmentsRead = await request(app).get('/api/stock-adjustments?selectedOutletId=')
      .set(auth());
    const countsRead = await request(app).get('/api/stock-counts')
      .query({ selectedOutletId: ids.otherOutlet }).set(auth());

    expect(adjustmentsRead.status).toBe(200);
    expect(adjustmentsRead.body.stockAdjustments).toEqual([]);
    expect(countsRead.status).toBe(200);
    expect(countsRead.body.stockCounts).toEqual([]);
    expect(StockCount.find.mock.calls.at(-1)[0].warehouseId.toString()).toBe(ids.warehouse);
  });

  it('only grants global stock access to Super Admin and denies unassigned users', () => {
    expect(hasGlobalStockAccess({ role: 'Team', permissions: ['stock:write'] })).toBe(false);
    expect(canManageLocation({ role: 'Team', permissions: [] }, ids.warehouse)).toBe(false);
    const centralUser = {
      locationId: ids.warehouse,
      location: { type: 'CENTRAL' },
    };
    expect(canManageLocation(centralUser, ids.outlet)).toBe(false);
    expect(canManageLocation(centralUser, ids.outlet, { allowCentralLocationSelection: true })).toBe(true);
    expect(hasGlobalStockAccess({ role: 'Super Admin', permissions: [] })).toBe(true);
    expect(canManageLocation({ role: 'Super Admin', permissions: [] }, ids.warehouse)).toBe(true);
    expect(hasGlobalStockAccess({ role: 'Team', permissions: ['*'] })).toBe(true);
  });

  it('posts adjustments at the configured limit and requires Super Admin approval above it', async () => {
    const missingReason = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      lines: [{ productId: ids.product, quantity: 1 }],
    });
    expect(missingReason.status).toBe(400);
    expect(movements).toHaveLength(1);

    const atLimit = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'ADD',
      reason: 'Data entry correction',
      lines: [{ productId: ids.product, quantity: 5 }],
    });
    expect(atLimit.status).toBe(201);
    expect(atLimit.body.stockAdjustment).toMatchObject({ value: 100, approvalLimit: 100, status: 'Approved' });
    expect(stockAt(ids.warehouse, ids.product)).toBe(15);

    const aboveLimit = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'REMOVE',
      reason: 'Damaged',
      lines: [{ productId: ids.product, quantity: 6 }],
    });
    expect(aboveLimit.status).toBe(201);
    expect(aboveLimit.body.stockAdjustment).toMatchObject({ value: 120, status: 'Pending' });
    expect(stockAt(ids.warehouse, ids.product)).toBe(15);

    const denied = await request(app).post(`/api/stock-adjustments/${aboveLimit.body.stockAdjustment._id}/approve`)
      .set(auth());
    expect(denied.status).toBe(403);
    user = {
      _id: new mongoose.Types.ObjectId(ids.admin),
      isActive: true,
      roleId: { name: 'Super Admin', permissions: ['*'] },
    };
    const approved = await request(app).post(`/api/stock-adjustments/${aboveLimit.body.stockAdjustment._id}/approve`)
      .set(auth(ids.admin));
    expect(approved.status).toBe(200);
    expect(approved.body.stockAdjustment.status).toBe('Approved');
    expect(stockAt(ids.warehouse, ids.product)).toBe(9);
    expect(movements[movements.length - 1]).toMatchObject({ type: 'ADJUSTMENT', quantity: -6 });
    expect(auditLogs.some((entry) => entry.action === 'APPROVE' && entry.entity === 'StockAdjustment')).toBe(true);
  });

  it('rejects reason and mode mismatches and stores a required note for Other', async () => {
    const invalidReasons = [
      { mode: 'ADD', reason: 'Damaged' },
      { mode: 'REMOVE', reason: 'Found extra stock' },
      { mode: 'ADD', reason: 'Other' },
    ];
    for (const invalid of invalidReasons) {
      const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
        warehouseId: ids.warehouse,
        ...invalid,
        lines: [{ productId: ids.product, quantity: 1 }],
      });
      expect(response.status).toBe(400);
    }
    expect(movements).toHaveLength(1);
    expect(adjustments.size).toBe(0);

    const validOther = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'ADD',
      reason: 'Other',
      reasonNote: 'Unrecorded delivery',
      lines: [{ productId: ids.product, quantity: 2 }],
    });
    expect(validOther.status).toBe(201);
    expect(validOther.body.stockAdjustment.reason).toBe('Other: Unrecorded delivery');
    expect(movements[movements.length - 1]).toMatchObject({ type: 'ADJUSTMENT', quantity: 2 });
  });

  it('blocks removing more than the current location stock', async () => {
    const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'REMOVE',
      reason: 'Lost or stolen',
      lines: [{ productId: ids.product, quantity: 11 }],
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Cannot remove more stock than is currently available at this location');
    expect(stockAt(ids.warehouse, ids.product)).toBe(10);
    expect(adjustments.size).toBe(0);
  });

  it.each([
    [1, 22],
    [23, 0],
  ])('removes %i from location stock of 23 and leaves %i', async (quantity, expectedStock) => {
    movements[0].quantity = 23;
    Settings.findOne.mockReturnValue(query({ stockAdjustmentApprovalLimit: 1000 }));

    const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'REMOVE',
      reason: 'Expired',
      lines: [{ productId: ids.product, quantity }],
    });

    expect(response.status).toBe(201);
    expect(response.body.stockAdjustment.status).toBe('Approved');
    expect(stockAt(ids.warehouse, ids.product)).toBe(expectedStock);
    expect(movements[movements.length - 1]).toMatchObject({
      type: 'ADJUSTMENT',
      quantity: -quantity,
    });
  });

  it('rejects removing 24 from location stock of 23', async () => {
    movements[0].quantity = 23;

    const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'REMOVE',
      reason: 'Expired',
      lines: [{ productId: ids.product, quantity: 24 }],
    });

    expect(response.status).toBe(409);
    expect(response.body.message).toBe('Cannot remove more stock than is currently available at this location');
    expect(stockAt(ids.warehouse, ids.product)).toBe(23);
    expect(adjustments.size).toBe(0);
  });

  it('allows adding stock regardless of the current balance', async () => {
    movements[0].quantity = 23;
    Settings.findOne.mockReturnValue(query({ stockAdjustmentApprovalLimit: 1000 }));

    const response = await request(app).post('/api/stock-adjustments').set(auth()).send({
      warehouseId: ids.warehouse,
      mode: 'ADD',
      reason: 'Found extra stock',
      lines: [{ productId: ids.product, quantity: 24 }],
    });

    expect(response.status).toBe(201);
    expect(response.body.stockAdjustment.status).toBe('Approved');
    expect(stockAt(ids.warehouse, ids.product)).toBe(47);
    expect(movements[movements.length - 1]).toMatchObject({ type: 'ADJUSTMENT', quantity: 24 });
  });

  it('searches adjustment products on the server with location stock and remove-mode filtering', async () => {
    const removeResults = await request(app).get('/api/stock/products').set(auth()).query({
      warehouseId: ids.warehouse, mode: 'REMOVE', q: 'Sample', limit: 10,
    });
    expect(removeResults.status).toBe(200);
    expect(removeResults.body.products).toMatchObject([{
      id: ids.product, name: 'Sample Product', stockQuantity: 10,
    }]);

    movements = [];
    const addResults = await request(app).get('/api/stock/products').set(auth()).query({
      warehouseId: ids.warehouse, mode: 'ADD', q: 'Sample', limit: 10,
    });
    expect(addResults.status).toBe(200);
    expect(addResults.body.products).toMatchObject([{ id: ids.product, stockQuantity: 0 }]);

    const emptyRemoveResults = await request(app).get('/api/stock/products').set(auth()).query({
      warehouseId: ids.warehouse, mode: 'REMOVE', q: 'Sample', limit: 10,
    });
    expect(emptyRemoveResults.status).toBe(200);
    expect(emptyRemoveResults.body.products).toEqual([]);
  });

  it('records system and counted quantities then posts only the calculated difference', async () => {
    const created = await request(app).post('/api/stock-counts').set(auth()).send({
      warehouseId: ids.warehouse,
      reason: 'Monthly stock count',
      lines: [{ productId: ids.product, countedQuantity: 12 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.stockCount.lines[0]).toMatchObject({
      expectedQuantity: 10,
      countedQuantity: 12,
      difference: 2,
    });

    const posted = await request(app).post(`/api/stock-counts/${created.body.stockCount._id}/post`).set(auth());
    expect(posted.status).toBe(200);
    expect(posted.body.stockCount.status).toBe('Posted');
    expect(stockAt(ids.warehouse, ids.product)).toBe(12);
    expect(movements[movements.length - 1]).toMatchObject({
      type: 'ADJUSTMENT',
      quantity: 2,
      reason: 'Monthly stock count',
      referenceType: 'StockAdjustment',
    });
    expect([...adjustments.values()][0].stockCountId.toString()).toBe(created.body.stockCount._id);
    expect(auditLogs.some((entry) => entry.entity === 'StockCount' && entry.action === 'POST')).toBe(true);
  });
});
