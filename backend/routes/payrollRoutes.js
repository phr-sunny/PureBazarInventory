const express = require('express');
const { body, param, query } = require('express-validator');
const payrollController = require('../controllers/payrollController');
const rosterController = require('../controllers/rosterController');
const salarySheetController = require('../controllers/salarySheetController');
const workShiftController = require('../controllers/workShiftController');
const authMiddleware = require('../middlewares/authMiddleware');
const authorizeMiddleware = require('../middlewares/authorizeMiddleware');
const enforceLocationScope = require('../middlewares/enforceLocationScope');
const validateRequest = require('../middlewares/validateRequest');

const router = express.Router();
const can = (permission) => [authMiddleware, authorizeMiddleware({ permissions: [permission] })];
const methods = ['Cash', 'Bank', 'bKash', 'Nagad', 'Card'];
const mongoId = (name) => param(name).isMongoId().withMessage(`A valid ${name} is required`);
const money = (chain) => chain.isFloat({ min: 0 }).withMessage('Must be 0 or more').toFloat();

const employeeFields = (optional) => {
  const wrap = (chain) => (optional ? chain.optional() : chain);
  return [
    wrap(body('employeeCode')).isString().trim().isLength({ min: 1, max: 50 }),
    wrap(body('name')).isString().trim().isLength({ min: 1, max: 150 }),
    wrap(money(body('baseSalary'))),
    body('phone').optional().isString().trim().isLength({ max: 30 }),
    body('email').optional().isEmail(),
    body('designation').optional().isString().trim().isLength({ max: 100 }),
    body('department').optional().isString().trim().isLength({ max: 100 }),
    body('hireDate').optional().isISO8601({ strict: true }),
    body('userId').optional({ nullable: true }).isMongoId(),
    body('locationId').optional({ nullable: true }).isMongoId(),
    body('employmentType').optional({ nullable: true }).isIn(['full-time', 'part-time']),
    body('isStudent').optional({ nullable: true }).isBoolean().toBoolean(),
    body('notes').optional({ nullable: true }).isString().trim().isLength({ max: 1000 }),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ];
};

const workShiftLocation = enforceLocationScope.forWorkRostering;

router.get('/employees', can('employees:read'), [
  query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
], validateRequest, payrollController.listEmployees);
router.post('/employees', can('employees:write'), employeeFields(false),
  validateRequest, payrollController.createEmployee);
router.patch('/employees/:id', can('employees:write'), [mongoId('id'), ...employeeFields(true)],
  validateRequest, payrollController.updateEmployee);
router.get('/employee-users', ...can('employees:write'), workShiftLocation, [
  query('locationId').optional().isMongoId(),
], validateRequest, payrollController.listLinkableUsers);

router.get('/work-shifts', can('hr.work-shifts:read'), workShiftLocation, [
  query('locationId').optional().isMongoId(),
], validateRequest, workShiftController.listWorkShifts);
router.post('/work-shifts', can('hr.work-shifts:write'), workShiftLocation, [
  body('name').isString().trim().isLength({ min: 1, max: 100 }),
  body('startTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('endTime').matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('locationId').optional().isMongoId(),
], validateRequest, workShiftController.createWorkShift);
router.patch('/work-shifts/:id', can('hr.work-shifts:write'), workShiftLocation, [
  mongoId('id'),
  body('name').optional().isString().trim().isLength({ min: 1, max: 100 }),
  body('startTime').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('endTime').optional().matches(/^([01]\d|2[0-3]):[0-5]\d$/),
  body('isActive').optional().isBoolean().toBoolean(),
  body('locationId').optional().isMongoId(),
], validateRequest, workShiftController.updateWorkShift);

router.get('/my-roster', ...can('hr.shift-roster:read'), rosterController.myUpcomingRoster);
router.get('/roster', can('hr.shift-roster:read'), workShiftLocation, [
  query('weekStart').matches(/^\d{4}-\d{2}-\d{2}$/).isISO8601({ strict: true }),
  query('locationId').optional().isMongoId(),
], validateRequest, rosterController.listRoster);
router.post('/roster', can('hr.shift-roster:write'), workShiftLocation, [
  body('employeeId').isMongoId(),
  body('workShiftId').isMongoId(),
  body('date').matches(/^\d{4}-\d{2}-\d{2}$/).isISO8601({ strict: true }),
  body('notes').optional().isString().trim().isLength({ max: 500 }),
  body('locationId').optional().isMongoId(),
], validateRequest, rosterController.assignShift);
router.delete('/roster/:id', can('hr.shift-roster:write'), workShiftLocation, [
  mongoId('id'),
  query('locationId').optional().isMongoId(),
], validateRequest, rosterController.removeShift);
router.post('/roster/copy-last-week', can('hr.shift-roster:write'), workShiftLocation, [
  body('weekStart').custom((value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Week start must be a date in YYYY-MM-DD format');
    return true;
  }),
  body('locationId').optional().isMongoId(),
], validateRequest, rosterController.copyLastWeek);

router.get('/advances', can('payroll:read'), [
  query('employeeId').optional().isMongoId(),
  query('status').optional().isIn(['Draft', 'Approved', 'Paid', 'Rejected']),
], validateRequest, payrollController.listAdvances);
router.post('/advances', can('payroll:write'), [
  body('employeeId').isMongoId().withMessage('A valid employee is required'),
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0').toFloat(),
  body('reason').isString().trim().isLength({ min: 1, max: 500 }),
  body('requestedAt').optional().isISO8601({ strict: true }),
], validateRequest, payrollController.createAdvance);
router.post('/advances/:id/approve', can('payroll:write'), [mongoId('id')], validateRequest, payrollController.approveAdvance);
router.post('/advances/:id/reject', can('payroll:write'), [mongoId('id')], validateRequest, payrollController.rejectAdvance);
router.post('/advances/:id/pay', can('payroll:write'), [mongoId('id')], validateRequest, payrollController.payAdvance);

router.get('/sheets', can('payroll:read'), [
  query('status').optional().isIn(['Draft', 'Approved', 'Paid']),
], validateRequest, salarySheetController.listSheets);
router.post('/sheets', can('payroll:write'), [
  body('month').matches(/^\d{4}-(0[1-9]|1[0-2])$/).withMessage('Month must be YYYY-MM'),
], validateRequest, salarySheetController.createSheet);
router.get('/sheets/:id', can('payroll:read'), [mongoId('id')], validateRequest, salarySheetController.getSheet);
router.patch('/sheets/:id/lines/:employeeId', can('payroll:write'), [
  mongoId('id'), mongoId('employeeId'),
  money(body('allowances').optional()),
  money(body('otherDeductions').optional()),
], validateRequest, salarySheetController.updateLine);
router.post('/sheets/:id/approve', can('payroll:write'), [mongoId('id')], validateRequest, salarySheetController.approveSheet);
router.post('/sheets/:id/pay', ...can('payroll:write'), enforceLocationScope.forExpenseWrite, [
  mongoId('id'),
  body('paymentMethod').isIn(methods).withMessage('Invalid payment method'),
  body('locationId').optional().isMongoId(),
], validateRequest, salarySheetController.paySheet);
router.get('/sheets/:id/payslips/:employeeId', can('payroll:read'), [
  mongoId('id'), mongoId('employeeId'),
], validateRequest, salarySheetController.payslip);

module.exports = router;
