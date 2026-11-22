const mongoose = require('mongoose');
const {
  Product, StockMovement, Vendor,
} = require('../models');
const { statusError } = require('./posBillService');
const { effectiveSubUnitPrice } = require('../utils/piecePricing');
const { unitLabelMap, displayFields } = require('../utils/productDisplay');
const { barcodeMatches } = require('../utils/productBarcodes');

function fifoStock(movements, productIds) {
  const result = new Map(productIds.map((id) => [String(id), { stock: 0, receivedAt: null }]));
  const lots = new Map(productIds.map((id) => [String(id), []]));
  movements.forEach((movement) => {
    const key = movement.productId.toString();
    const productLots = lots.get(key);
    if (!productLots) return;
    const quantity = Number(movement.quantity) || 0;
    if (quantity > 0) {
      let remaining = quantity;
      while (remaining > 0 && productLots.length && productLots[0].remaining < 0) {
        const offset = Math.min(remaining, -productLots[0].remaining);
        productLots[0].remaining += offset;
        remaining -= offset;
        if (productLots[0].remaining === 0) productLots.shift();
      }
      if (remaining > 0) productLots.push({
        remaining,
        receivedAt: ['GRN', 'TRANSFER_IN'].includes(movement.type) ? movement.createdAt : null,
      });
    } else if (quantity < 0) {
      let remaining = -quantity;
      while (remaining > 0 && productLots.length && productLots[0].remaining > 0) {
        const consumed = Math.min(remaining, productLots[0].remaining);
        productLots[0].remaining -= consumed;
        remaining -= consumed;
        if (productLots[0].remaining === 0) productLots.shift();
      }
      if (remaining > 0) {
        if (productLots.length && productLots[0].remaining < 0) productLots[0].remaining -= remaining;
        else productLots.unshift({ remaining: -remaining, receivedAt: null });
      }
    }
  });
  result.forEach((entry, key) => {
    const productLots = lots.get(key);
    entry.stock = Math.max(0, productLots.reduce((sum, lot) => sum + lot.remaining, 0));
    entry.receivedAt = productLots
      .filter((lot) => lot.remaining > 0 && lot.receivedAt)
      .map((lot) => new Date(lot.receivedAt).getTime())
      .sort((a, b) => a - b)[0] || null;
  });
  return result;
}

function sortByFifo(products, stock) {
  return [...products].sort((a, b) => {
    const aStock = stock.get(a._id.toString());
    const bStock = stock.get(b._id.toString());
    if ((aStock?.stock > 0) !== (bStock?.stock > 0)) return aStock?.stock > 0 ? -1 : 1;
    if (aStock?.receivedAt !== bStock?.receivedAt) {
      if (!aStock?.receivedAt) return 1;
      if (!bStock?.receivedAt) return -1;
      return aStock.receivedAt - bStock.receivedAt;
    }
    return String(a.name).localeCompare(String(b.name));
  });
}

async function stockByProduct(outletId, productIds) {
  if (!productIds.length) return new Map();
  const movements = await StockMovement.find({
    warehouseId: new mongoose.Types.ObjectId(String(outletId)),
    productId: { $in: productIds.map((id) => new mongoose.Types.ObjectId(String(id))) },
  }).select('productId quantity type createdAt').sort({ createdAt: 1, _id: 1 }).lean();
  return fifoStock(movements, productIds);
}

async function vendorNameMap(products) {
  const ids = [...new Set(products.map((product) => product.vendorId?.toString()).filter(Boolean))];
  if (!ids.length) return new Map();
  const vendors = await Vendor.find({ _id: { $in: ids } }).select('_id name shopName').lean();
  return new Map(vendors.map((vendor) => [vendor._id.toString(), vendor.shopName || vendor.name]));
}

function toItem(product, stock, labels = new Map(), vendors = new Map()) {
  const stockInfo = stock.get(String(product._id)) || { stock: 0, receivedAt: null };
  return {
    productId: product._id,
    name: product.name,
    ...displayFields(product, labels),
    barcode: product.barcode,
    barcodes: product.barcodes || [],
    barcodeSource: product.barcodeSource,
    productGroupId: product.productGroupId,
    vendorId: product.vendorId?.toString() || null,
    vendorName: vendors.get(product.vendorId?.toString()) || null,
    mrp: product.mrp,
    unitValue: product.unitValue,
    vendorPrice: product.vendorPrice,
    subUnitPrice: effectiveSubUnitPrice(product) ?? undefined,
    unitsPerPackage: product.unitsPerPackage,
    stock: stockInfo.stock,
    receivedAt: stockInfo.receivedAt,
  };
}

async function scanItem(req, res, next) {
  try {
    const value = String(req.params.barcode || '').trim();
    const products = await Product.find({
      $or: [{ barcode: value }, { barcodes: value }],
    }).sort({ name: 1 }).lean();
    if (!products.length) throw statusError('Product barcode was not found', 404);
    const stock = await stockByProduct(req.locationId, products.map((product) => product._id));
    const sorted = sortByFifo(products, stock);
    const [labels, vendors] = await Promise.all([
      unitLabelMap(sorted),
      vendorNameMap(sorted),
    ]);
    const candidates = sorted.map((product) => toItem(product, stock, labels, vendors));
    return res.json({ success: true, item: { ...candidates[0], vendorMatches: candidates } });
  } catch (error) {
    return next(error);
  }
}

async function searchItems(req, res, next) {
  try {
    const term = String(req.query.q || '').trim();
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'i');
    const products = await Product.find({
      $or: [{ name: regex }, { barcode: regex }, { barcodes: regex }, { sku: regex }],
    }).sort({ name: 1 }).limit(10).lean();
    const stock = await stockByProduct(req.locationId, products.map((product) => product._id));
    const sorted = sortByFifo(products, stock);
    const [labels, vendors] = await Promise.all([
      unitLabelMap(sorted),
      vendorNameMap(sorted),
    ]);
    const candidates = sorted
      .filter((product) => barcodeMatches(product, term))
      .map((product) => toItem(product, stock, labels, vendors));
    const vendorMatches = candidates.length > 1 ? candidates : undefined;
    return res.json({
      success: true,
      items: sorted.map((product) => ({
        ...toItem(product, stock, labels, vendors),
        ...(vendorMatches ? { vendorMatches } : {}),
      })),
    });
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  fifoStock, scanItem, searchItems, sortByFifo, stockByProduct, toItem,
};
