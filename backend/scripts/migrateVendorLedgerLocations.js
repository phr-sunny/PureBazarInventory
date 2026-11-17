const dotenv = require('dotenv');
const path = require('path');
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const { Location, Order, VendorLedger } = require('../models');

dotenv.config({ path: path.join(__dirname, '../.env') });
dotenv.config();

function buildVendorLedgerLocationUpdates(lines, orders, centralLocationId) {
  const orderLocations = new Map(orders.map((order) => [String(order._id), order.outlet]));
  return lines.flatMap((line) => {
    const locationId = orderLocations.get(String(line.orderId)) || centralLocationId;
    if (!locationId) {
      throw new Error(`No linked order or central warehouse for vendor ledger line ${line._id}`);
    }
    if (String(line.locationId || '') === String(locationId)) return [];
    return [{ id: line._id, locationId }];
  });
}

async function migrateVendorLedgerLocations() {
  const lines = await VendorLedger.find().select('_id orderId locationId').lean();
  if (!lines.length) return { scanned: 0, updated: 0 };

  const orderIds = [...new Set(lines.map((line) => String(line.orderId))
    .filter((orderId) => mongoose.isValidObjectId(orderId)))];
  const orders = orderIds.length
    ? await Order.find({ _id: { $in: orderIds } }).select('_id outlet').lean()
    : [];
  const orderLocations = new Map(orders.map((order) => [String(order._id), order.outlet]));
  const needsCentral = lines.some((line) => !orderLocations.get(String(line.orderId)));
  const central = needsCentral ? await Location.findOne({ type: 'CENTRAL' }).select('_id').lean() : null;
  const updates = buildVendorLedgerLocationUpdates(lines, orders, central?._id);
  if (!updates.length) return { scanned: lines.length, updated: 0 };

  const result = await VendorLedger.bulkWrite(updates.map(({ id, locationId }) => ({
    updateOne: {
      filter: { _id: id },
      update: { $set: { locationId } },
    },
  })), { ordered: true, runValidators: true });

  return { scanned: lines.length, updated: result.modifiedCount };
}

async function main() {
  if (!process.argv.includes('--apply')) {
    throw new Error('Pass --apply to backfill vendor ledger locations in the configured database');
  }
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

  await connectDB(process.env.MONGODB_URI);
  const result = await migrateVendorLedgerLocations();
  console.log(`Vendor ledger location migration complete: ${JSON.stringify(result)}`);
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Vendor ledger location migration failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    });
}

module.exports = { buildVendorLedgerLocationUpdates, migrateVendorLedgerLocations };
