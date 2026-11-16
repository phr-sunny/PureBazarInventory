const express = require('express');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const request = require('supertest');

jest.mock('../models', () => {
  const same = (left, right) => String(left?._id || left) === String(right?._id || right);
  const matches = (document, filter) => Object.entries(filter).every(([key, condition]) => {
    if (key === '$or') return condition.some((clause) => matches(document, clause));
    const value = document[key];
    if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
      if ('$in' in condition) return condition.$in.some((item) => same(value, item));
      if ('$ne' in condition) return !same(value, condition.$ne);
    }
    return same(value, condition);
  });
  const list = (items) => {
    const promise = Promise.resolve(items);
    promise.sort = () => promise;
    promise.select = () => promise;
    promise.populate = () => promise;
    promise.lean = () => Promise.resolve(items);
    return promise;
  };
  const collection = (name) => ({
    find: jest.fn((filter = {}) => list(global.__db[name].filter((doc) => matches(doc, filter)))),
    findOne: jest.fn(() => ({ lean: async () => global.__db[name][0] || null })),
  });
  return {
    AuditLog: collection('AuditLog'),
    User: { findById: jest.fn() },
    Order: collection('Order'),
    Product: collection('Product'),
    StockMovement: collection('StockMovement'),
    Location: { ...collection('Location'), findById: jest.fn() },
    VendorLedger: collection('VendorLedger'),
    VendorStatement: collection('VendorStatement'),
    Expense: collection('Expense'),
    GoodsReceive: collection('GoodsReceive'),
    StockAdjustment: collection('StockAdjustment'),
    Settings: collection('Settings'),
    Shift: collection('Shift'),
  };
});

const models = require('../models');
const dashboardRoutes = require('../routes/dashboardRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');

const secret = 'role-dashboard-secret';
const id = () => new mongoose.Types.ObjectId();
const me = id();
const other = id();
const p1 = id(); const p2 = id(); const outlet = id(); const vendor = id();
const today = new Date();
const order = (cashier, grandTotal, payments, number) => ({
  _id: id(), orderNumber: number, cashier, grandTotal, payments, paymentStatus: 'PAID',
  soldAt: today, lines: [{}], outlet,
});

function seed() {
  global.__db = {
    Order: [
      order(me, 100.1, [{ method: 'CASH', amount: 100.1 }], 'B1'),
      order(me, 200.2, [{ method: 'BKASH', amount: 100.1 }, { method: 'CARD', amount: 100.1 }], 'B2'),
      order(other, 5000, [{ method: 'CASH', amount: 5000 }], 'OTHER'),
    ],
    Settings: [{ dailySalesTarget: 1000 }],
    Shift: [{ outletId: outlet, openedAt: new Date(today.getTime() - 3600000), openingCash: 500 }],
    Product: [{ _id: p1, name: 'Rice', barcode: '1' }, { _id: p2, name: 'Oil', barcode: '2' }],
    Location: [{ _id: outlet, type: 'OUTLET', name: 'Outlet-1', isActive: true }],
    StockMovement: [
      { productId: p1, warehouseId: outlet, quantity: 6, type: 'GRN' },
      { productId: p1, warehouseId: outlet, quantity: -3, type: 'SALE', createdAt: today },
      { productId: p2, warehouseId: outlet, quantity: 4, type: 'GRN' },
      { productId: p2, warehouseId: outlet, quantity: -4, type: 'SALE', createdAt: today },
    ],
    GoodsReceive: [{ _id: id(), status: 'Draft', warehouseId: outlet, ownerType: 'COMPANY', lines: [{}], createdAt: today }],
    StockAdjustment: [{ _id: id(), warehouseId: outlet, status: 'Pending', reason: 'Damage', lines: [{}], createdAt: today }],
    VendorLedger: [{
      vendorId: vendor, orderId: id(), locationId: outlet, entryType: 'SALE',
      vendorPayable: 10, companyNet: 10, createdAt: today,
    }],
    VendorStatement: [{
      vendorId: vendor, periodStart: new Date(today.getTime() - 86400000),
      periodEnd: new Date(today.getTime() + 86400000), status: 'Approved', netPayable: 50,
    }],
    Expense: [],
    AuditLog: [],
  };
}

describe('role-specific dashboards', () => {
  const app = express();
  app.use('/api/dashboard', dashboardRoutes);
  app.use(errorMiddleware);
  let role;
  const auth = () => ({ Authorization: `Bearer ${jwt.sign({ sub: me.toString() }, secret)}` });
  const get = async () => (await request(app).get('/api/dashboard').set(auth())).body.dashboard;

  beforeEach(() => {
    seed();
    process.env.JWT_SECRET = secret;
    models.User.findById.mockImplementation(() => ({
      populate: jest.fn(async () => ({
        _id: me, isActive: true,
        locationId: role.name === 'Super Admin' ? null : { _id: outlet, name: 'Outlet-1', type: 'OUTLET' },
        roleId: { _id: id(), name: role.name, permissions: role.permissions },
      })),
    }));
  });

  it('cashier sees only their own progress', async () => {
    role = { name: 'Outlet Cashier', permissions: ['dashboard:read'] };
    const d = await get();
    expect(d.view).toBe('cashier');
    expect(d.todaySales).toBe(300.3);
    expect(d.todayBillCount).toBe(2);
    expect(d.targetProgressPercent).toBe(30);
    expect(d.paymentSplit).toEqual({ cash: 100.1, bkash: 100.1, card: 100.1, other: 0 });
    expect(d.shift.expectedCash).toBe(600.1);
    expect(d.recentBills.map((bill) => bill.orderNumber).sort()).toEqual(['B1', 'B2']);
    ['totalSales', 'marginIncome', 'vendorPayablesDue', 'lowStockAlerts'].forEach((key) => expect(d).not.toHaveProperty(key));
  });

  it('inventory manager sees stock progress and no finance data', async () => {
    role = { name: 'Inventory Manager', permissions: ['dashboard:read'] };
    const d = await get();
    expect(d.view).toBe('inventory');
    expect(d.lowStockCount).toBe(1);
    expect(d.stockOutCount).toBe(1);
    expect(d.pendingGrnCount).toBe(1);
    expect(d.fastMoving[0]).toEqual(expect.objectContaining({ productName: 'Oil', soldQuantity: 4 }));
    expect(d.reorderRecommendations.find((r) => r.productName === 'Oil').suggestedQuantity).toBe(20);
    expect(d.recentAdjustments).toHaveLength(1);
    ['totalSales', 'marginIncome', 'vendorPayablesDue', 'todaySales'].forEach((key) => expect(d).not.toHaveProperty(key));
  });

  it('super admin keeps the full enterprise dashboard', async () => {
    role = { name: 'Super Admin', permissions: ['*'] };
    const d = await get();
    expect(d.view).toBe('admin');
    expect(d.totalSales).toBe(5300.3);
    expect(d.marginIncome).toBe(10);
    expect(d.vendorPayablesDue).toBe(50);
  });

  it('custom role with module read access inherits matching widgets', async () => {
    role = { name: 'Operations Manager', permissions: ['dashboard:read', 'inventory.products:read', 'pos.sales:read'] };
    const d = await get();
    expect(d.view).toBe('general');
    expect(d.sections).toEqual(['sales', 'inventory']);
    expect(d.todaySales).toBe(5300.3);
    expect(d.lowStockAlerts).toHaveLength(2);
    expect(d.recentActivity).toEqual([]);
    ['totalSales', 'marginIncome', 'vendorPayablesDue'].forEach((key) => expect(d).not.toHaveProperty(key));
  });

  it('other roles get no business data', async () => {
    role = { name: 'Finance', permissions: ['dashboard:read'] };
    expect(await get()).toEqual({ view: 'general', generatedAt: expect.any(String) });
  });
});
