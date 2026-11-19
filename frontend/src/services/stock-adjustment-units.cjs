const {
  combineQuantity, formatBoxPieces, isMultiUnit, toGrams,
} = require('./stock-units.cjs');

const isWeightLine = (line) => line.isWeightBased && !isMultiUnit(line.unitsPerPackage);
const lineQuantity = (line) => (isWeightLine(line)
  ? toGrams(line.kg, 'Kg')
  : isMultiUnit(line.unitsPerPackage)
    ? combineQuantity(line.boxes, line.pieces, line.unitsPerPackage)
    : Number(line.quantity));
const invalidLine = (line) => (isWeightLine(line)
  ? !Number.isFinite(Number(line.kg)) || !(Number(line.kg) > 0)
    || String(line.kg ?? '').trim() === ''
  : isMultiUnit(line.unitsPerPackage)
    ? !Number.isFinite(lineQuantity(line))
      || Number(line.boxes) < 0 || !Number.isInteger(Number(line.boxes))
      || Number(line.pieces) < 0 || !Number.isInteger(Number(line.pieces))
      || lineQuantity(line) <= 0
    : !Number.isFinite(lineQuantity(line)) || lineQuantity(line) <= 0);
const stockText = (quantity, product) => formatBoxPieces(
  quantity, product?.unitsPerPackage, product?.packageUnitName,
);

module.exports = {
  isWeightLine, lineQuantity, invalidLine, stockText,
};
