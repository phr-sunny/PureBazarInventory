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
    find: jest.fn((filter = {}) => list(global.__locationDb[name].filter((doc) => matches(doc, filter)))),
    findOne: jest.fn(() => ({ lean: async () => global.__locationDb[name][0] || null })),
  });
  return {
    AuditLog: collection('AuditLog'),
    Expense: collection('Expense'),
    Location: {
      ...collection('Location'),
      findById: jest.fn((locationId) => ({
        select: () => ({ lean: async () => global.__locationDb.Location.find((item) => same(item._id, locationId)) || null }),
      })),
    },
    Order: collection('Order'),
    Product: collection('Product'),
    Settings: collection('Settings'),
    StockMovement: collection('StockMovement'),
    User: { findById: jest.fn() },
    VendorLedger: collection('VendorLedger'),
    VendorStatement: collection('VendorStatement'),
  };
});

const models = require('../models');
const dashboardRoutes = require('../routes/dashboardRoutes');
const errorMiddleware = require('../middlewares/errorMiddleware');
const { dhakaBounds } = require('../services/dashboardService');

const secret = 'dashboard-location-secret';
const id = () => new mongoose.Types.ObjectId();
const userId = id();
const outlet = id();
const central = id();
const productId = id();
const vendorId = id();
const sum = (items, pick) => items.reduce((total, item) => (
  total + Math.round((Number(pick(item)) + Number.EPSILON) * 100)
), 0) / 100;

let roleName;
let permissions;
let assignedLocationId;
let reportDate;

function seed() {
  reportDate = new Date();
  const outletOrder = {
    _id: id(), outlet, paymentStatus: 'PAID', grandTotal: 100,
    payments: [{ method: 'CASH', amount: 100 }], soldAt: reportDate,
  };
  const centralOrder = {
    _id: id(), outlet: central, paymentStatus: 'PAID', grandTotal: 200,
    payments: [{ method: 'WALLET', amount: 200 }], soldAt: reportDate,
  };
  global.__locationDb = {
    AuditLog: [
      { _id: id(), action: 'OUTLET_ACTION', entity: 'Order', metadata: { locationId: outlet }, createdAt: reportDate },
      { _id: id(), action: 'CENTRAL_ACTION', entity: 'Order', metadata: { locationId: central }, createdAt: reportDate },
    ],
    Expense: [
      { locationId: outlet, amount: 5, expenseDate: reportDate },
      { locationId: central, amount: 7, expenseDate: reportDate },
    ],
    Location: [
      { _id: outlet, type: 'OUTLET', name: 'Outlet One', isActive: true },
      { _id: central, type: 'CENTRAL', name: 'Central Warehouse', isActive: true },
    ],
    Order: [outletOrder, centralOrder],
    Product: [{ _id: productId, name: 'Rice', barcode: 'R1' }],
    Settings: [],
    StockMovement: [
      { productId, warehouseId: outlet, quantity: 6 },
      { productId, warehouseId: outlet, quantity: -2 },
      { productId, warehouseId: central, quantity: 12 },
      { productId, warehouseId: central, quantity: -4 },
    ],
    VendorLedger: [
      {
        vendorId, orderId: outletOrder._id, locationId: outlet, entryType: 'SALE',
        vendorPayable: 100, companyNet: 12, createdAt: reportDate,
      },
      {
        vendorId, orderId: centralOrder._id, entryType: 'SALE',
        vendorPayable: 100, companyNet: 20, createdAt: reportDate,
      },
    ],
    VendorStatement: [{
      vendorId,
      periodStart: new Date(reportDate.getTime() - 86400000),
      periodEnd: new Date(reportDate.getTime() + 86400000),
      status: 'Approved',
      netPayable: 100,
    }],
  };
}

describe('location-scoped dashboard API', () => {
  const app = express();
  app.use('/api/dashboard', dashboardRoutes);
  app.use(errorMiddleware);
  const auth = () => ({ Authorization: `Bearer ${jwt.sign({ sub: userId.toString() }, secret)}` });
  const load = (locationId) => request(app).get(`/api/dashboard${locationId ? `?locationId=${locationId}` : ''}`).set(auth());

  beforeEach(() => {
    process.env.JWT_SECRET = secret;
    roleName = 'Super Admin';
    permissions = ['*'];
    assignedLocationId = null;
    seed();
    models.User.findById.mockImplementation(() => ({
      populate: jest.fn(async () => ({
        _id: userId,
        isActive: true,
        locationId: assignedLocationId ? { _id: assignedLocationId, name: 'Outlet One', type: 'OUTLET' } : null,
        roleId: { _id: userId, name: roleName, permissions },
      })),
    }));
  });

  it('matches direct database calculations and All equals both location totals', async () => {
    const stockBeforeTransfer = sum(global.__locationDb.StockMovement, (movement) => movement.quantity);
    global.__locationDb.StockMovement.push(
      { productId, warehouseId: outlet, quantity: -1, type: 'TRANSFER_OUT' },
      { productId, warehouseId: central, quantity: 1, type: 'TRANSFER_IN' },
    );
    expect(sum(global.__locationDb.StockMovement, (movement) => movement.quantity)).toBe(stockBeforeTransfer);

    const [allResponse, outletResponse, centralResponse] = await Promise.all([
      load(), load(outlet), load(central),
    ]);
    const all = allResponse.body.dashboard;
    const outletDashboard = outletResponse.body.dashboard;
    const centralDashboard = centralResponse.body.dashboard;
    const bounds = dhakaBounds(reportDate);

    [ [outlet, outletDashboard], [central, centralDashboard] ].forEach(([locationId, dashboard]) => {
      const orders = global.__locationDb.Order.filter((order) => String(order.outlet) === String(locationId));
      const today = orders.filter((order) => order.soldAt >= bounds.dayStart && order.soldAt < bounds.dayEnd);
      const expenses = global.__locationDb.Expense.filter((expense) => String(expense.locationId) === String(locationId)
        && expense.expenseDate >= bounds.monthStart && expense.expenseDate < bounds.monthEnd);
      const ledger = global.__locationDb.VendorLedger.filter((entry) => (
        String(entry.locationId || orders.find((order) => String(order._id) === String(entry.orderId))?.outlet) === String(locationId)
      ));
      const movements = global.__locationDb.StockMovement.filter((movement) => String(movement.warehouseId) === String(locationId));

      expect(dashboard.totalSales).toBe(sum(orders, (order) => order.grandTotal));
      expect(dashboard.todaySales).toBe(sum(today, (order) => order.grandTotal));
      expect(dashboard.todayBillCount).toBe(today.length);
      expect(dashboard.todayByPaymentMethod).toEqual({ [today[0].payments[0].method]: today[0].payments[0].amount });
      expect(dashboard.walletBillTotal).toBe(dashboard.todayByPaymentMethod.WALLET || 0);
      expect(dashboard.marginIncome).toBe(sum(ledger, (entry) => entry.companyNet));
      expect(dashboard.monthExpenses).toBe(sum(expenses, (expense) => expense.amount));
      expect(dashboard.lowStockAlerts.map((item) => [item.locationId, item.quantity])).toEqual([
        [String(locationId), sum(movements, (movement) => movement.quantity)],
      ]);
    });

    expect(outletDashboard.vendorPayablesDue).toBe(50);
    expect(centralDashboard.vendorPayablesDue).toBe(50);
    expect(all.totalSales).toBe(sum([outletDashboard, centralDashboard], (item) => item.totalSales));
    expect(all.todaySales).toBe(sum([outletDashboard, centralDashboard], (item) => item.todaySales));
    expect(all.marginIncome).toBe(sum([outletDashboard, centralDashboard], (item) => item.marginIncome));
    expect(all.vendorPayablesDue).toBe(sum([outletDashboard, centralDashboard], (item) => item.vendorPayablesDue));
    expect(all.monthExpenses).toBe(sum([outletDashboard, centralDashboard], (item) => item.monthExpenses));
    expect(all.lowStockAlerts).toHaveLength(outletDashboard.lowStockAlerts.length + centralDashboard.lowStockAlerts.length);
  });

  it('keeps a locked user at their assigned location despite a requested location', async () => {
    roleName = 'Operations Manager';
    permissions = ['dashboard:read', 'finance:read'];
    assignedLocationId = outlet;

    const response = await load(central);

    expect(response.status).toBe(200);
    expect(response.body.dashboard.totalSales).toBe(100);
    expect(response.body.dashboard.marginIncome).toBe(12);
    expect(response.body.dashboard.monthExpenses).toBe(5);
    expect(response.body.dashboard.vendorPayablesDue).toBe(50);
    expect(response.body.dashboard.recentActivity.map((item) => item.action)).toEqual(['OUTLET_ACTION']);
  });
});
