const { randomBytes } = require('crypto');

const INTERNAL_BARCODE_PREFIX = 'PB';

function generateInternalBarcode() {
  return `${INTERNAL_BARCODE_PREFIX}${randomBytes(8).toString('hex').toUpperCase()}`;
}

function normalizeBarcodes(barcode, barcodes = []) {
  return [...new Set([barcode, ...(Array.isArray(barcodes) ? barcodes : [])]
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
}

function barcodeMatches(product, barcode) {
  const value = String(barcode || '').trim();
  return product.barcode === value || (product.barcodes || []).includes(value);
}

module.exports = {
  INTERNAL_BARCODE_PREFIX,
  barcodeMatches,
  generateInternalBarcode,
  normalizeBarcodes,
};
