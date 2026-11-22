const {
  AuditLog, Brand, Category, PriceHistory, Product, Settings, Unit, Vendor,
} = require('../models');
const { unitLabelMap, displayFields } = require('../utils/productDisplay');
const { createVendorCopy } = require('../services/vendorProductCopy');

const editableFields = [
  'name', 'sku', 'categoryId', 'brandId', 'unitId', 'unitValue', 'ownerType', 'vendorId', 'barcode', 'barcodes', 'barcodeSource',
  'vendorPrice', 'mrp', 'vatApplicable', 'vatRate', 'unitsPerPackage', 'subUnitPriceOverride',
];
const creationFields = editableFields.filter((field) => field !== 'unitValue');

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function handleError(error, next) {
  if (error.code === 11000) error.status = 409;
  if (error.name === 'ValidationError') {
    error.status = 400;
    error.errors = Object.entries(error.errors).map(([field, detail]) => ({
      field,
      message: detail.message,
    }));
  }
  return next(error);
}

function productData(product) {
  return product.toObject ? product.toObject() : product;
}

function productSnapshot(product) {
  const data = productData(product);
  return Object.fromEntries([
    'name', 'sku', 'categoryId', 'brandId', 'unitId', 'unitValue', 'ownerType', 'vendorId', 'productGroupId',
    'vendorPrice', 'mrp', 'margin', 'vatApplicable', 'vatRate', 'barcode',
    'barcodes', 'barcodeSource', 'unitsPerPackage', 'subUnitPriceOverride', 'subUnitPrice',
  ].filter((field) => data[field] !== undefined)
    .map((field) => [field, data[field]?.toString && (field.endsWith('Id') || field === 'productGroupId')
      ? data[field].toString() : data[field]]));
}

function productOutput(product, discountPercent, labels = new Map(), vendors = new Map()) {
  const data = productData(product);
  const maximumDiscount = Math.round((data.mrp * discountPercent / 100 + Number.EPSILON) * 100) / 100;
  const result = productSnapshot(data);
  result.id = data._id.toString();
  result.vendorName = vendors.get(data.vendorId?.toString()) || null;
  Object.assign(result, displayFields(data, labels));
  result.marginWarning = data.margin < maximumDiscount;
  result.createdAt = data.createdAt;
  result.updatedAt = data.updatedAt;
  return result;
}

async function discountPercent() {
  const settings = await Settings.findOne({ singleton: 'global' }).lean();
  return settings?.shareholderDiscountPercent ?? 5;
}

async function vendorNameMap(products) {
  const ids = [...new Set(products.map((product) => product.vendorId?.toString()).filter(Boolean))];
  if (!ids.length) return new Map();
  const vendors = await Vendor.find({ _id: { $in: ids } }).select('_id name shopName').lean();
  return new Map(vendors.map((vendor) => [vendor._id.toString(), vendor.shopName || vendor.name]));
}

function barcodeFilter(value) {
  return { $or: [{ barcode: value }, { barcodes: value }] };
}

async function validateReferences(data) {
  const checks = [
    [Category, data.categoryId, 'Category'],
    [Unit, data.unitId, 'Unit'],
    [Brand, data.brandId, 'Brand'],
  ];
  for (const [Model, id, label] of checks) {
    if (id && !(await Model.exists({ _id: id }))) {
      throw statusError(`${label} not found`, 400);
    }
  }

  if (data.ownerType === 'VENDOR') {
    if (!data.vendorId) throw statusError('Vendor-owned products require a vendor', 400);
    if (!(await Vendor.exists({ _id: data.vendorId }))) throw statusError('Vendor not found', 400);
  } else if (data.vendorId) {
    throw statusError('Company-owned products cannot have a vendor', 400);
  }
}

function pickInput(body, fields = editableFields) {
  return Object.fromEntries(fields
    .filter((field) => Object.prototype.hasOwnProperty.call(body, field))
    .map((field) => [field, body[field]]));
}

async function listProducts(req, res, next) {
  try {
    const [products, percent] = await Promise.all([
      Product.find().sort({ name: 1 }).lean(),
      discountPercent(),
    ]);
    const [labels, vendors] = await Promise.all([unitLabelMap(products), vendorNameMap(products)]);
    return res.json({
      success: true,
      products: products.map((product) => productOutput(product, percent, labels, vendors)),
      marginWarningPercent: percent,
    });
  } catch (error) {
    return next(error);
  }
}

async function getProduct(req, res, next) {
  try {
    const [product, percent] = await Promise.all([
      Product.findById(req.params.id).lean(),
      discountPercent(),
    ]);
    if (!product) throw statusError('Product not found', 404);
    const [labels, vendors] = await Promise.all([unitLabelMap([product]), vendorNameMap([product])]);
    return res.json({ success: true, product: productOutput(product, percent, labels, vendors) });
  } catch (error) {
    return next(error);
  }
}

async function createProduct(req, res, next) {
  try {
    const input = pickInput(req.body, creationFields);
    await validateReferences(input);
    const product = await Product.create(input);
    const after = productSnapshot(product);
    await AuditLog.create({
      actorId: req.user._id,
      action: 'CREATE',
      entity: 'Product',
      entityId: product._id,
      after,
      ipAddress: req.ip,
    });
    return res.status(201).json({
      success: true,
      product: productOutput(product, await discountPercent(), await unitLabelMap([product]), await vendorNameMap([product])),
    });
  } catch (error) {
    return handleError(error, next);
  }
}

async function updateProduct(req, res, next) {
  try {
    const product = await Product.findById(req.params.id);
    if (!product) throw statusError('Product not found', 404);

    const before = productSnapshot(product);
    const input = pickInput(req.body);
    if (!Object.keys(input).length) throw statusError('At least one product field must be supplied', 400);
    const changesPrice = ['vendorPrice', 'mrp'].some((field) => (
      Object.prototype.hasOwnProperty.call(input, field) && input[field] !== product[field]
    ));
    const nextValues = { ...productData(product), ...input };
    if (Number(nextValues.mrp) < Number(nextValues.vendorPrice)) {
      throw statusError('MRP must be greater than or equal to vendor price', 400);
    }
    await validateReferences(nextValues);
    product.set(input);
    await product.save();

    const after = productSnapshot(product);
    if (changesPrice) {
      await PriceHistory.create({
        productId: product._id,
        oldVendorPrice: before.vendorPrice,
        newVendorPrice: after.vendorPrice,
        oldMrp: before.mrp,
        newMrp: after.mrp,
        changedBy: req.user._id,
        ...(req.body.reason ? { reason: req.body.reason } : {}),
      });
    }
    await AuditLog.create({
      actorId: req.user._id,
      action: 'UPDATE',
      entity: 'Product',
      entityId: product._id,
      before,
      after,
      ...(changesPrice ? { metadata: { priceChanged: true } } : {}),
      ipAddress: req.ip,
    });

    return res.json({
      success: true,
      product: productOutput(product, await discountPercent(), await unitLabelMap([product]), await vendorNameMap([product])),
    });
  } catch (error) {
    return handleError(error, next);
  }
}

async function findBarcodeMatches(req, res, next) {
  try {
    const value = String(req.params.barcode || '').trim();
    const products = await Product.find(barcodeFilter(value)).sort({ name: 1 }).lean();
    const vendors = await vendorNameMap(products);
    return res.json({
      success: true,
      products: products.map((product) => ({
        id: product._id.toString(),
        name: product.name,
        barcode: product.barcode,
        vendorId: product.vendorId?.toString() || null,
        vendorName: vendors.get(product.vendorId?.toString()) || null,
      })),
    });
  } catch (error) {
    return next(error);
  }
}

async function addVendorCopy(req, res, next) {
  try {
    const { copy, vendor } = await createVendorCopy({
      sourceProductId: req.params.id,
      vendorId: req.body.vendorId,
      vendorPrice: req.body.vendorPrice,
      mrp: req.body.mrp,
      actorId: req.user._id,
      ipAddress: req.ip,
    });
    return res.status(201).json({
      success: true,
      product: productOutput(
        copy,
        await discountPercent(),
        await unitLabelMap([copy]),
        new Map([[vendor._id.toString(), vendor.shopName || vendor.name]]),
      ),
    });
  } catch (error) {
    return handleError(error, next);
  }
}

module.exports = {
  addVendorCopy, createProduct, findBarcodeMatches, getProduct, listProducts, updateProduct,
};
