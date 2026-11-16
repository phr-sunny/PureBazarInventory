const {
  AuditLog, Expense, Location, Order, Product, Settings, StockMovement, VendorLedger, VendorStatement,
} = require('../models');

const { buildTrends } = require('./dashboardTrends');

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const DEFAULT_LOW_STOCK_THRESHOLD = 10;
const RECENT_ACTIVITY_LIMIT = 10;
const LOW_STOCK_LIMIT = 50;

const cents = (value) => Math.round((Number(value) + Number.EPSILON) * 100);
const money = (totalCents) => totalCents / 100;
const sumCents = (items, pick) => items.reduce((sum, item) => sum + cents(pick(item) || 0), 0);

// Asia/Dhaka calendar day and month boundaries, expressed as UTC instants.
function dhakaBounds(now) {
  const local = new Date(now.getTime() + DHAKA_OFFSET_MS);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const at = (year, month, day) => new Date(Date.UTC(year, month, day) - DHAKA_OFFSET_MS);
  return {
    dayStart: at(y, m, d),
    dayEnd: at(y, m, d + 1),
    monthStart: at(y, m, 1),
    monthEnd: at(y, m + 1, 1),
  };
}

const soldTime = (order) => new Date(order.soldAt || order.createdAt).getTime();

// Stock is kept in main units; the fractional part is pieces of a package.
function formatStockQuantity(quantity, unitName, unitsPerPackage) {
  const totalCents = cents(quantity);
  const unit = unitName || 'unit';
  const perPackage = Number(unitsPerPackage);
  if (!(perPackage > 1) || totalCents < 0) return `${totalCents / 100} ${unit}`;
  const totalPieces = Math.round((totalCents / 100) * perPackage);
  const whole = Math.floor(totalPieces / perPackage);
  const pieces = totalPieces - whole * perPackage;
  const parts = [];
  if (whole || !pieces) parts.push(`${whole} ${unit}`);
  if (pieces) parts.push(`${pieces} Pcs`);
  return parts.join(' ');
}

async function resolveLowStockThreshold(threshold) {
  if (Number.isFinite(Number(threshold)) && threshold !== undefined && threshold !== null) return Number(threshold);
  const settings = await Settings.findOne({ singleton: 'global' }).lean();
  const stored = settings ? Number(settings.lowStockThreshold) : NaN;
  return Number.isFinite(stored) ? stored : DEFAULT_LOW_STOCK_THRESHOLD;
}

async function lowStockAlerts(thresholdInput, { locationId, allLocations = false } = {}) {
  // Notifications default to outlets; dashboard scopes pass their active locations explicitly.
  const threshold = await resolveLowStockThreshold(thresholdInput);
  const settings = await Settings.findOne({ singleton: 'global' }).lean();
  const includeCentral = Boolean(settings && settings.centralWarehouseLowStockEnabled);
  const locationFilter = locationId
    ? { _id: locationId }
    : { type: allLocations || includeCentral ? { $in: ['OUTLET', 'CENTRAL'] } : 'OUTLET', isActive: { $ne: false } };
  const [outlets, products] = await Promise.all([
    Location.find(locationFilter).select('name').lean(),
    Product.find({}).select('name barcode unitsPerPackage unitId').populate('unitId', 'name').lean(),
  ]);
  const outletNames = new Map(outlets.map((outlet) => [String(outlet._id), outlet.name]));
  const movementResults = outletNames.size
    ? await StockMovement.find({ warehouseId: { $in: [...outletNames.keys()] } }).lean()
    : [];
  const movements = movementResults.filter((movement) => outletNames.has(String(movement.warehouseId)));
  const quantities = new Map();
  movements.forEach((movement) => {
    const key = `${movement.productId}|${movement.warehouseId}`;
    quantities.set(key, (quantities.get(key) || 0) + cents(movement.quantity));
  });
  const names = new Map(products.map((product) => [String(product._id), product]));
  return [...quantities.entries()]
    .map(([key, total]) => ({ key, total, productId: key.split('|')[0], locationId: key.split('|')[1] }))
    .filter(({ productId, total }) => names.has(productId) && total < cents(threshold))
    .map(({ productId, locationId, total }) => ({
      productId,
      quantityLabel: formatStockQuantity(
        total / 100,
        names.get(productId).unitId && names.get(productId).unitId.name,
        names.get(productId).unitsPerPackage,
      ),
      productName: names.get(productId).name,
      barcode: names.get(productId).barcode,
      locationId,
      locationName: outletNames.get(locationId),
      quantity: total / 100,
    }))
    .sort((a, b) => a.quantity - b.quantity || a.productName.localeCompare(b.productName))
    .slice(0, LOW_STOCK_LIMIT);
}

function locationOfLedgerEntry(entry, orderLocations) {
  return entry.locationId || orderLocations.get(String(entry.orderId)) || null;
}

function auditLogHasLocation(log, locationId) {
  const locations = new Set();
  const read = (record) => {
    if (!record || typeof record !== 'object') return;
    for (const field of ['locationId', 'warehouseId', 'outlet', 'outletId', 'fromWarehouseId', 'toWarehouseId']) {
      if (record[field]) locations.add(String(record[field]._id || record[field]));
    }
  };
  read(log.metadata);
  read(log.before);
  read(log.after);
  return locations.has(String(locationId));
}

function allocatedPayables(statements, ledger, orderLocations, locationId) {
  const entriesByVendor = new Map();
  ledger.forEach((entry) => {
    const date = new Date(entry.createdAt).getTime();
    const location = locationOfLedgerEntry(entry, orderLocations);
    if (!location || !Number.isFinite(date)) return;
    const vendor = String(entry.vendorId);
    if (!entriesByVendor.has(vendor)) entriesByVendor.set(vendor, []);
    const amount = cents(entry.vendorPayable || 0) * (entry.entryType === 'RETURN' ? -1 : 1);
    entriesByVendor.get(vendor).push({ location: String(location), date, amount });
  });

  let totalCents = 0;
  statements.forEach((statement) => {
    const periodStart = new Date(statement.periodStart).getTime();
    const periodEnd = new Date(statement.periodEnd).getTime();
    const vendorEntries = entriesByVendor.get(String(statement.vendorId)) || [];
    const weights = new Map();
    vendorEntries.forEach((entry) => {
      if (entry.date < periodStart || entry.date > periodEnd) return;
      weights.set(entry.location, (weights.get(entry.location) || 0) + entry.amount);
    });
    const positiveWeights = [...weights.entries()]
      .filter(([, amount]) => amount > 0)
      .sort(([a], [b]) => a.localeCompare(b));
    const totalWeight = positiveWeights.reduce((sum, [, amount]) => sum + amount, 0);
    if (!totalWeight) return;

    const payableCents = cents(statement.netPayable);
    let remainingCents = payableCents;
    positiveWeights.forEach(([location, weight], index) => {
      const allocation = index === positiveWeights.length - 1
        ? remainingCents
        : Math.floor((payableCents * weight) / totalWeight);
      remainingCents -= allocation;
      if (!locationId || location === String(locationId)) totalCents += allocation;
    });
  });
  return money(totalCents);
}

async function getDashboard({ now = new Date(), lowStockThreshold, locationId = null } = {}) {
  const { dayStart, dayEnd, monthStart, monthEnd } = dhakaBounds(now);
  lowStockThreshold = await resolveLowStockThreshold(lowStockThreshold);
  const activeLocations = await Location.find({
    type: { $in: ['CENTRAL', 'OUTLET'] }, isActive: { $ne: false },
  }).select('_id').lean();
  const activeLocationIds = activeLocations.map((location) => String(location._id));
  const scopeLocationIds = locationId ? [String(locationId)] : activeLocationIds;
  const sourceLocationFilter = locationId || { $in: activeLocations.map((location) => location._id) };
  const [orders, allOrders, statements, expenses, recent, lowStock] = await Promise.all([
    Order.find({ paymentStatus: 'PAID', outlet: sourceLocationFilter }).lean(),
    Order.find({ outlet: { $in: activeLocations.map((location) => location._id) } }).select('_id outlet').lean(),
    VendorStatement.find({ status: 'Approved' }).lean(),
    Expense.find({ locationId: sourceLocationFilter }).lean(),
    AuditLog.find({}).sort({ createdAt: -1 }).lean(),
    lowStockAlerts(lowStockThreshold, { locationId, allLocations: true }),
  ]);

  const ledger = await VendorLedger.find({
    $or: [
      { locationId: { $in: activeLocations.map((location) => location._id) } },
      { orderId: { $in: allOrders.map((order) => order._id) } },
    ],
  }).lean();
  const orderLocations = new Map(allOrders.map((order) => [String(order._id), order.outlet]));
  const allLocationLedger = ledger.filter((entry) => activeLocationIds.includes(
    String(locationOfLedgerEntry(entry, orderLocations)),
  ));
  const scopedLedger = locationId
    ? allLocationLedger.filter((entry) => scopeLocationIds.includes(
      String(locationOfLedgerEntry(entry, orderLocations)),
    ))
    : allLocationLedger;
  const today = orders.filter((order) => soldTime(order) >= dayStart.getTime()
    && soldTime(order) < dayEnd.getTime());
  const todayByMethod = {};
  today.forEach((order) => order.payments.forEach((payment) => {
    todayByMethod[payment.method] = (todayByMethod[payment.method] || 0) + cents(payment.amount);
  }));
  const monthExpenses = expenses.filter((expense) => new Date(expense.expenseDate) >= monthStart
    && new Date(expense.expenseDate) < monthEnd);
  const visibleRecent = locationId ? recent.filter((log) => auditLogHasLocation(log, locationId)) : recent;

  return {
    totalSales: money(sumCents(orders, (order) => order.grandTotal)),
    marginIncome: money(sumCents(scopedLedger, (entry) => entry.companyNet)),
    todaySales: money(sumCents(today, (order) => order.grandTotal)),
    todayBillCount: today.length,
    todayByPaymentMethod: Object.fromEntries(
      Object.entries(todayByMethod).sort(([a], [b]) => a.localeCompare(b))
        .map(([method, total]) => [method, money(total)]),
    ),
    walletBillTotal: money(todayByMethod.WALLET || 0),
    lowStockThreshold,
    lowStockAlerts: lowStock,
    recentActivity: visibleRecent.slice(0, RECENT_ACTIVITY_LIMIT).map((log) => ({
      id: String(log._id), action: log.action, entity: log.entity, entityId: log.entityId || null,
      actorId: log.actorId || null, createdAt: log.createdAt,
    })),
    vendorPayablesDue: allocatedPayables(statements, allLocationLedger, orderLocations, locationId),
    monthExpenses: money(sumCents(monthExpenses, (expense) => expense.amount)),
    ...buildTrends(orders, expenses, now),
    generatedAt: now,
  };
}

module.exports = {
  getDashboard, dhakaBounds, lowStockAlerts, resolveLowStockThreshold, formatStockQuantity, DEFAULT_LOW_STOCK_THRESHOLD,
};
