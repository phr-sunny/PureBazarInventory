const express = require('express');
const { query } = require('express-validator');
const authMiddleware = require('../middlewares/authMiddleware');
const authorizeMiddleware = require('../middlewares/authorizeMiddleware');
const enforceLocationScope = require('../middlewares/enforceLocationScope');
const validateRequest = require('../middlewares/validateRequest');
const { salesReport, stockReport } = require('../services/salesStockReportService');
const { vendorProfitability, profitLoss, vatDiscountReport } = require('../services/financeReportService');
const { toExcel, toPdf } = require('../services/reportExportService');
const { getAttendanceReport } = require('../controllers/attendanceController');
const { Employee } = require('../models');

const router = express.Router();
router.use(authMiddleware);
router.use(enforceLocationScope.forAccountingRead);

const dateRange = [
  query('from').optional().isISO8601({ strict: true }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('from must be YYYY-MM-DD'),
  query('to').optional().isISO8601({ strict: true }).matches(/^\d{4}-\d{2}-\d{2}$/).withMessage('to must be YYYY-MM-DD'),
  query('locationId').optional({ values: 'falsy' }).isMongoId().withMessage('A valid location is required'),
  query('to').custom((to, { req }) => !req.query.from || !to || to >= req.query.from).withMessage('to must not be before from'),
];
const wrap = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};
const reportAccess = (key, legacy) => authorizeMiddleware({ anyPermissions: [...legacy, `${key}:read`, `${key}:write`] });
const salesAccess = reportAccess('reports.sales', ['reports:read', 'reports:sales-stock:read']);
const stockAccess = reportAccess('reports.stock', ['reports:read', 'reports:sales-stock:read']);
const vendorProfitAccess = reportAccess('reports.vendor-profit', ['reports:read']);
const profitLossAccess = reportAccess('reports.profit-loss', ['reports:read']);
const vatDiscountAccess = reportAccess('reports.vat-discount', ['reports:read']);
const exportFormats = [
  query('format').optional().isIn(['json', 'xlsx', 'pdf']).withMessage('format must be json, xlsx or pdf'),
];
const periodSubtitle = (report) => `Period: ${report.from || 'start'} to ${report.to || 'today'}`;
const sendReportExport = async (res, format, filename, sheet) => {
  if (format === 'xlsx') {
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', `attachment; filename="${filename}.xlsx"`);
    return res.send(await toExcel(sheet));
  }
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${filename}.pdf"`);
  return res.send(await toPdf(sheet));
};

router.get('/sales', salesAccess, dateRange, [
  query('groupBy').optional().isIn(['day', 'month']).withMessage('groupBy must be day or month'),
  ...exportFormats,
], validateRequest, wrap(async (req, res) => {
  const report = await salesReport({ ...req.query, locationId: req.locationId });
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  return sendReportExport(res, format, 'sales-report', {
    title: 'Sales Report',
    subtitle: periodSubtitle(report),
    columns: [
      { key: 'period', label: 'Period', width: 18 },
      { key: 'billCount', label: 'Bills' },
      { key: 'subtotal', label: 'Subtotal' },
      { key: 'discounts', label: 'Discounts' },
      { key: 'vat', label: 'VAT' },
      { key: 'totalSales', label: 'Total sales' },
    ],
    rows: report.rows,
    totals: report.totals,
  });
}));

router.get('/stock', stockAccess, dateRange, [
  query('lowStockThreshold').optional().isFloat({ min: 0 }).withMessage('Threshold must be 0 or more').toFloat(),
  ...exportFormats,
], validateRequest, wrap(async (req, res) => {
  const report = await stockReport({ ...req.query, locationId: req.locationId });
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  return sendReportExport(res, format, 'stock-report', {
    title: 'Stock Report',
    subtitle: `${periodSubtitle(report)}; low stock threshold: ${report.lowStockThreshold}`,
    columns: [
      { key: 'productName', label: 'Product', width: 28 },
      { key: 'barcode', label: 'Barcode', width: 20 },
      { key: 'opening', label: 'Opening' },
      { key: 'received', label: 'Received' },
      { key: 'sold', label: 'Sold net' },
      { key: 'otherChange', label: 'Other change' },
      { key: 'closing', label: 'Closing' },
      { key: 'onHand', label: 'On hand' },
      { key: 'turnover', label: 'Turnover' },
    ],
    rows: report.rows,
  });
}));

router.get('/vendor-profitability', vendorProfitAccess, dateRange, [
  ...exportFormats,
], validateRequest, wrap(async (req, res) => {
  const report = await vendorProfitability({ ...req.query, locationId: req.locationId });
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  return sendReportExport(res, format, 'vendor-profitability', {
    title: 'Vendor Profitability',
    subtitle: periodSubtitle(report),
    columns: [
      { key: 'vendorName', label: 'Vendor', width: 28 },
      { key: 'shopName', label: 'Shop', width: 24 },
      { key: 'billCount', label: 'Bills' },
      { key: 'quantitySold', label: 'Qty sold' },
      { key: 'vendorPayable', label: 'Vendor payable' },
      { key: 'companyNet', label: 'Company net' },
    ],
    rows: report.rows,
    totals: report.totals,
  });
}));

router.get('/profit-loss', profitLossAccess, dateRange, exportFormats, validateRequest, wrap(async (req, res) => {
  const report = await profitLoss({ ...req.query, locationId: req.locationId });
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  const rows = [
    { item: 'Vendor margin income', amount: report.marginIncome },
    { item: 'Own-stock margin', amount: report.ownStockMargin },
    { item: 'Discounts', amount: report.discounts },
    { item: 'Expenses', amount: report.expenses },
    ...report.expensesByCategory.map((expense) => ({ item: `Expense: ${expense.category}`, amount: expense.total })),
    { item: 'Net profit', amount: report.netProfit },
  ];
  return sendReportExport(res, format, 'profit-loss-report', {
    title: 'Profit and Loss Report',
    subtitle: periodSubtitle(report),
    columns: [{ key: 'item', label: 'Item', width: 36 }, { key: 'amount', label: 'Amount' }],
    rows,
  });
}));

router.get('/vat-discount', vatDiscountAccess, dateRange, exportFormats, validateRequest, wrap(async (req, res) => {
  const report = await vatDiscountReport({ ...req.query, locationId: req.locationId });
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  return sendReportExport(res, format, 'vat-discount-report', {
    title: 'VAT and Discount Report',
    subtitle: periodSubtitle(report),
    columns: [
      { key: 'period', label: 'Period', width: 18 },
      { key: 'billCount', label: 'Bills' },
      { key: 'vat', label: 'VAT' },
      { key: 'itemDiscount', label: 'Item discount' },
      { key: 'billDiscount', label: 'Bill discount' },
      { key: 'shareholderDiscount', label: 'Shareholder discount' },
      { key: 'totalDiscount', label: 'Total discount' },
    ],
    rows: report.rows,
    totals: report.totals,
  });
}));

router.get('/attendance', authorizeMiddleware({ permissions: ['attendance:read'] }), [
  query('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('month must be YYYY-MM'),
  query('locationId').optional({ values: 'falsy' }).isMongoId().withMessage('A valid location is required'),
  ...exportFormats,
], validateRequest, wrap(async (req, res) => {
  const userHasAllLocations = Boolean(req.user.canViewAllLocations);
  const employee = await Employee.findOne({
    userId: req.user._id, status: 'ACTIVE',
  });
  const selfOnly = Boolean(employee) && !userHasAllLocations
    && !req.user.permissions.includes('attendance:write')
    && !req.user.permissions.includes('*');
  const locationId = selfOnly ? employee.locationId : req.locationId;
  const employeeFilter = selfOnly
    ? { _id: employee._id, status: 'ACTIVE' }
    : { status: 'ACTIVE', ...(locationId ? { locationId } : {}) };
  const report = await getAttendanceReport(req.query.month, locationId, employeeFilter);
  const format = req.query.format || 'json';
  if (format === 'json') return res.json({ success: true, report });
  return sendReportExport(res, format, 'attendance-report', {
    title: 'Attendance Report',
    subtitle: `Month: ${report.month}`,
    columns: [
      { key: 'employeeCode', label: 'Employee code', width: 18 },
      { key: 'employeeName', label: 'Employee', width: 26 },
      { key: 'rosteredShifts', label: 'Rostered shifts' },
      { key: 'attended', label: 'Attended' },
      { key: 'absent', label: 'Absent' },
      { key: 'lateCount', label: 'Late' },
      { key: 'totalWorkedHours', label: 'Worked hours' },
    ],
    rows: report.rows,
  });
}));

module.exports = router;
