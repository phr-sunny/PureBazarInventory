const mongoose = require('mongoose');
const { buildVendorLedgerLocationUpdates } = require('../scripts/migrateVendorLedgerLocations');

const objectId = () => new mongoose.Types.ObjectId();

describe('vendor ledger location backfill', () => {
  it('uses the linked order outlet and falls back to the central warehouse', () => {
    const outlet = objectId();
    const central = objectId();
    const linkedOrder = objectId();
    const missingOrder = objectId();
    const lines = [
      { _id: objectId(), orderId: linkedOrder },
      { _id: objectId(), orderId: missingOrder },
    ];

    expect(buildVendorLedgerLocationUpdates(
      lines,
      [{ _id: linkedOrder, outlet }],
      central,
    )).toEqual([
      { id: lines[0]._id, locationId: outlet },
      { id: lines[1]._id, locationId: central },
    ]);
  });

  it('fails explicitly when neither an order outlet nor central warehouse is available', () => {
    const line = { _id: objectId(), orderId: objectId() };
    expect(() => buildVendorLedgerLocationUpdates([line], [], null))
      .toThrow(`No linked order or central warehouse for vendor ledger line ${line._id}`);
  });
});
