'use client';

import { Button, Input } from '@/components/ui';
import { formatBoxPieces, isMultiUnit } from '@/services/stock-units.cjs';
import { isWeightLine, lineQuantity, stockText } from '@/services/stock-adjustment-units.cjs';

export default function StockAdjustmentLine({ line, product, mode, onChange, onRemove }) {
  const update = (field, value) => onChange(line.productId, field, value);
  const overStock = mode === 'REMOVE' && lineQuantity(line) > Number(line.stockQuantity);

  return (
    <div className="grid items-end gap-3 rounded-lg border border-slate-200 p-3 sm:grid-cols-[1fr_10rem_16rem_auto]">
      <div>
        <strong className="block text-sm">{product?.name || 'Product'}</strong>
        <small className="text-slate-500">{product?.barcode}</small>
      </div>
      <span className="pb-2 text-sm text-slate-600">Current stock: {stockText(line.stockQuantity, product)}</span>
      <div>
        {isWeightLine(line) ? (
          <Input label="Quantity (Kg)" type="number" min="0.001" step="0.001" value={line.kg} onChange={(event) => update('kg', event.target.value)} />
        ) : isMultiUnit(line.unitsPerPackage) ? (
          <>
            <div className="grid grid-cols-2 gap-2">
              <Input label={line.packageUnitName || 'Box'} type="number" min="0" step="1" value={line.boxes} onChange={(event) => update('boxes', event.target.value)} />
              <Input label="Pieces" type="number" min="0" step="1" value={line.pieces} onChange={(event) => update('pieces', event.target.value)} />
            </div>
            <p className="mt-1 text-xs text-slate-500">Adjustment quantity: {formatBoxPieces(lineQuantity(line), line.unitsPerPackage, line.packageUnitName)}</p>
          </>
        ) : (
          <Input label="Quantity" type="number" min="0.000001" max={mode === 'REMOVE' ? line.stockQuantity : undefined} step="any" value={line.quantity} onChange={(event) => update('quantity', event.target.value)} />
        )}
        {overStock && <p className="mt-1 text-xs text-red-700">Cannot remove more than {stockText(line.stockQuantity, product)} currently in stock.</p>}
      </div>
      <Button type="button" variant="ghost" size="sm" onClick={onRemove}>Remove</Button>
    </div>
  );
}
