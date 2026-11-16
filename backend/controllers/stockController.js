const mongoose = require('mongoose');
const { Location, Product, StockMovement } = require('../models');
const { unitLabelMap, displayFields } = require('../utils/productDisplay');

async function getWarehouseStock(req, res, next) {
  try {
    const warehouseId = req.locationId || req.query.warehouseId;
    if (!warehouseId) {
      const error = new Error('Select a location to view stock');
      error.status = 400;
      throw error;
    }
    const location = await Location.findById(warehouseId).select('_id type isActive').lean();
    if (!location || location.isActive === false || !['CENTRAL', 'OUTLET'].includes(location.type)) {
      const error = new Error('Stock is available only for an active location');
      error.status = 400;
      throw error;
    }
    const grouped = await StockMovement.aggregate([
      { $match: { warehouseId: new mongoose.Types.ObjectId(warehouseId) } },
      { $group: { _id: '$productId', quantity: { $sum: '$quantity' } } },
      { $sort: { _id: 1 } },
    ]);
    const products = await Product.find({ _id: { $in: grouped.map(({ _id }) => _id) } })
      .select('_id name barcode ownerType vendorId unitId unitsPerPackage').lean();
    const labels = await unitLabelMap(products);
    const productMap = new Map(products.map((product) => [product._id.toString(), product]));
    const stock = grouped.map(({ _id, quantity }) => {
      const product = productMap.get(_id.toString());
      return {
        productId: _id.toString(),
        productName: product?.name,
        barcode: product?.barcode,
        ownerType: product?.ownerType,
        vendorId: product?.vendorId?.toString() || null,
        unitsPerPackage: product?.unitsPerPackage || 1,
        packageUnitName: product ? displayFields(product, labels).packageUnitName : null,
        quantity: Math.round(quantity * 1e6) / 1e6,
      };
    });
    return res.json({ success: true, warehouseId: warehouseId.toString(), stock });
  } catch (error) {
    return next(error);
  }
}

async function getOutletProducts(req, res, next) {
  try {
    const warehouseId = req.locationId || req.query.warehouseId;
    if (!warehouseId) {
      const error = new Error('Select a location to view outlet inventory');
      error.status = 400;
      throw error;
    }
    const location = await Location.findById(warehouseId).select('_id type isActive').lean();
    if (!location || location.isActive === false || !['CENTRAL', 'OUTLET'].includes(location.type)) {
      const error = new Error('Inventory is available only for an active location');
      error.status = 400;
      throw error;
    }
    const [products, grouped] = await Promise.all([
      Product.find().select('_id name sku barcode unitsPerPackage unitId').sort({ name: 1 }).lean(),
      StockMovement.aggregate([
        { $match: { warehouseId: new mongoose.Types.ObjectId(warehouseId) } },
        { $group: { _id: '$productId', quantity: { $sum: '$quantity' } } },
      ]),
    ]);
    const stockByProduct = new Map(grouped.map(({ _id, quantity }) => [_id.toString(), quantity]));
    const labels = await unitLabelMap(products);
    const inventory = products.map((product) => ({
      productId: product._id.toString(),
      name: product.name,
      sku: product.sku || '',
      barcode: product.barcode || '',
      unitsPerPackage: product.unitsPerPackage || 1,
      packageUnitName: displayFields(product, labels).packageUnitName,
      stock: Math.round((stockByProduct.get(product._id.toString()) || 0) * 1e6) / 1e6,
    }));
    return res.json({ success: true, warehouseId: warehouseId.toString(), products: inventory });
  } catch (error) {
    return next(error);
  }
}

module.exports = { getWarehouseStock, getOutletProducts };
