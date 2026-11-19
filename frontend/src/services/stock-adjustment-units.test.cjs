const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { invalidLine, lineQuantity } = require('./stock-adjustment-units.cjs');

describe('stock adjustment retail quantities', () => {
  it('converts whole boxes and pieces to fractional package quantities', () => {
    assert.equal(lineQuantity({ unitsPerPackage: 100, boxes: '0', pieces: '10' }), 0.1);
    assert.equal(lineQuantity({ unitsPerPackage: 100, boxes: '1', pieces: '0' }), 1);
  });

  it('requires a positive quantity and rejects non-whole box or piece counts', () => {
    assert.equal(invalidLine({ unitsPerPackage: 100, boxes: '0', pieces: '0' }), true);
    assert.equal(invalidLine({ unitsPerPackage: 100, boxes: '0', pieces: '10' }), false);
    assert.equal(invalidLine({ unitsPerPackage: 100, boxes: '0.5', pieces: '0' }), true);
    assert.equal(invalidLine({ isWeightBased: true, packageUnitName: 'Gram', kg: 'Infinity' }), true);
  });
});
