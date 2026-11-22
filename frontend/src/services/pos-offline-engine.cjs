const { calculateBill } = require('../../../backend/services/billEngine');
const { linePricing } = require('../../../backend/utils/piecePricing');

function calculateOfflineBill(items, billDiscount, methods, settings) {
  if (!methods.length || methods.includes('WALLET')) {
    throw new Error('Wallet payments require an internet connection.');
  }
  const firstMethod = methods[0];
  const lines = items.map((item) => {
    const pricing = linePricing(item, item);
    if (!pricing) throw new Error(`${item.name} cannot be sold by the piece.`);
    return {
      item,
      pricing,
      engineItem: {
        productId: item.productId,
        vendorId: item.vendorId,
        ownerType: item.ownerType,
        quantity: item.quantity,
        mrp: pricing.unitPrice,
        vendorPrice: pricing.unitVendorPrice,
        vatApplicable: item.vatApplicable,
        vatRate: item.vatRate,
        categoryVatRate: item.categoryVatRate,
        discount: item.discount,
      },
    };
  });
  const bill = calculateBill({
    items: lines.map((line) => line.engineItem),
    paymentMethod: firstMethod,
    billDiscount,
    settings,
  });
  const roleLimit = Number(settings.discountLimitByRole?.[settings.role] ?? 0);
  const discountApprovalRequired = bill.subtotal > 0
    && (bill.otherDiscountAmount / bill.subtotal) * 100 > roleLimit;
  return {
    ...bill,
    discountApprovalRequired,
    ledgerLines: bill.ledgerLines,
    lines,
  };
}

module.exports = { calculateOfflineBill };
