const mongoose = require('mongoose');
const Product = require('../models/Product');
const { barcodeMatches, INTERNAL_BARCODE_PREFIX } = require('../utils/productBarcodes');
const { fifoStock, sortByFifo } = require('../services/posCatalogService');
const {
  findBarcodeConflicts, isOldGlobalBarcodeIndex, makeIndexPlan,
} = require('../scripts/migrateVendorProductBarcodes');

describe('vendor barcode behavior', () => {
  it('allows the same code across vendors but identifies duplicates for the same vendor', () => {
    const products = [
      { _id: 'p1', ownerType: 'VENDOR', vendorId: 'v1', barcode: '4006381333931' },
      { _id: 'p2', ownerType: 'VENDOR', vendorId: 'v2', barcode: '4006381333931' },
    ];
    expect(findBarcodeConflicts(products)).toEqual([]);
    expect(findBarcodeConflicts([...products, {
      _id: 'p3', ownerType: 'VENDOR', vendorId: 'v1', barcode: '4006381333931',
    }])).toEqual([expect.objectContaining({ vendorId: 'v1', barcode: '4006381333931' })]);
  });

  it('indexes all identifiers uniquely within an owner and vendor scope', () => {
    const index = Product.schema.indexes().find(([, options]) => options.name === 'product_owner_vendor_barcode_unique');
    expect(index[0]).toEqual({ ownerType: 1, vendorId: 1, barcodeKeys: 1 });
    expect(index[1]).toMatchObject({ unique: true, partialFilterExpression: { barcodeKeys: { $exists: true } } });
  });

  it('generates a reserved internal barcode for an empty barcode field', async () => {
    const product = new Product({
      name: 'Test item',
      categoryId: new mongoose.Types.ObjectId(),
      unitId: new mongoose.Types.ObjectId(),
      ownerType: 'COMPANY',
      vendorPrice: 1,
      mrp: 2,
      barcode: '',
    });
    await product.validate();
    expect(product.barcode.startsWith(INTERNAL_BARCODE_PREFIX)).toBe(true);
    expect(product.barcodeSource).toBe('internal');
  });

  it('matches an extra barcode to the product', () => {
    expect(barcodeMatches({ barcode: 'PB-ORIGINAL', barcodes: ['01234567'] }, '01234567')).toBe(true);
  });

  it('chooses the product with the oldest remaining GRN/transfer-in lot', () => {
    const oldestId = new mongoose.Types.ObjectId();
    const newerId = new mongoose.Types.ObjectId();
    const locationId = new mongoose.Types.ObjectId();
    const movements = [
      { productId: oldestId, quantity: 5, type: 'GRN', createdAt: new Date('2026-01-01') },
      { productId: oldestId, quantity: -4, type: 'SALE', createdAt: new Date('2026-01-02') },
      { productId: newerId, quantity: 5, type: 'TRANSFER_IN', createdAt: new Date('2026-01-03') },
    ];
    const stock = fifoStock(movements, [oldestId, newerId]);
    const sorted = sortByFifo([
      { _id: newerId, name: 'New vendor' },
      { _id: oldestId, name: 'Old vendor' },
    ], stock);

    expect(stock.get(oldestId.toString())).toMatchObject({ stock: 1, receivedAt: new Date('2026-01-01').getTime() });
    expect(sorted[0]._id).toEqual(oldestId);
    expect(stock.get(newerId.toString()).stock).toBe(5);
  });

  it('recognizes the legacy global barcode index for migration', () => {
    expect(isOldGlobalBarcodeIndex({ name: 'barcode_1', key: { barcode: 1 }, unique: true })).toBe(true);
    expect(isOldGlobalBarcodeIndex({ name: 'name_1', key: { name: 1 }, unique: true })).toBe(false);
  });

  it('plans migration without applying changes and reports legacy generated codes', () => {
    const plan = makeIndexPlan([
      { _id: 'p1', ownerType: 'COMPANY', barcode: '4006381333931' },
    ], [{ name: 'barcode_1', key: { barcode: 1 }, unique: true }]);
    expect(plan).toMatchObject({
      scanned: 1,
      oldIndexes: ['barcode_1'],
      legacyGeneratedCount: 1,
      backfillCount: 1,
      newIndex: {
        name: 'product_owner_vendor_barcode_unique',
        unique: true,
      },
    });
  });
});
