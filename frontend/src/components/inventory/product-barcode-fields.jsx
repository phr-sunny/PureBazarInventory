'use client';

import { useCallback, useState } from 'react';
import { ScanLine } from 'lucide-react';
import { Button, Input } from '@/components/ui';
import CameraBarcodeScanner from '@/components/common/camera-barcode-scanner';
import useBarcodeScanner from '@/hooks/use-barcode-scanner';
import { getProductBarcodeMatches } from '@/services/inventory';
import { retailBarcodeWarning } from '@/services/barcodeEngine';

export default function ProductBarcodeFields({
  barcode, barcodes, barcodeSource, onChange, token, productId, onOpenExisting, onAddVendor,
}) {
  const [matches, setMatches] = useState([]);
  const [lookupError, setLookupError] = useState('');
  const warning = retailBarcodeWarning(barcode);
  const extraWarnings = String(barcodes).split(/\r?\n|,/)
    .map((value) => retailBarcodeWarning(value))
    .filter(Boolean);

  const handleScan = useCallback(async (value) => {
    const scanned = String(value || '').trim();
    if (!scanned) return;
    onChange({
      barcode: scanned,
      barcodeSource: scanned.startsWith('PB') ? 'internal' : 'manufacturer',
    });
    setLookupError('');
    try {
      const { data } = await getProductBarcodeMatches(token, scanned);
      setMatches((data.products || []).filter((product) => product.id !== productId));
    } catch (error) {
      setMatches([]);
      setLookupError(error.response?.data?.message || 'Unable to check whether this barcode is already used.');
    }
  }, [onChange, productId, token]);
  const scanner = useBarcodeScanner(handleScan);

  return (
    <div className="space-y-2 sm:col-span-2">
      <div className="flex items-end gap-2">
        <Input
          className="min-w-0 flex-1"
          label="Barcode"
          name="barcode"
          value={barcode}
          onChange={(event) => {
            const value = event.target.value;
            onChange({
              barcode: value,
              barcodeSource: value ? (value.startsWith('PB') ? 'internal' : 'manufacturer') : 'internal',
            });
            setMatches([]);
            setLookupError('');
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              scanner.onScan(event.currentTarget.value);
            }
          }}
          maxLength={100}
          placeholder="Scan or enter a manufacturer barcode; blank generates an internal barcode"
          autoComplete="off"
        />
        <CameraBarcodeScanner onScan={scanner.onScan} />
        <Button
          type="button"
          variant="secondary"
          className="hidden h-11 shrink-0 lg:inline-flex"
          onClick={() => document.getElementById('barcode')?.focus()}
          title="Focus for a USB barcode scanner"
        >
          <ScanLine size={16} /> Scan
        </Button>
      </div>
      {/* <p className="hidden text-xs text-slate-500 lg:block">On desktop, click Scan and use a USB scanner. On phones and tablets, use the camera button.</p>
      {barcodeSource && <p className="text-xs text-slate-500">Barcode source: {barcodeSource}</p>}
      {warning && <p role="status" className="text-xs text-amber-800">{warning} You can still save this code.</p>} */}
      {/* <label className="block text-sm font-medium text-slate-700" htmlFor="extra-barcodes">Extra barcodes</label>
      <textarea
        id="extra-barcodes"
        className="ui-input min-h-20 w-full"
        value={barcodes}
        onChange={(event) => onChange({ barcodes: event.target.value })}
        placeholder="One barcode per line (for example, box and piece codes)"
      /> */}
      {extraWarnings.map((message, index) => (
        <p key={`${index}-${message}`} role="status" className="text-xs text-amber-800">{message} This extra code can still be saved.</p>
      ))}
      {lookupError && <p role="alert" className="text-xs text-red-700">{lookupError}</p>}
      {matches.map((product) => (
        <div key={product.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-sm">
          <span>{product.name} · {product.vendorName || 'Company product'}</span>
          <span className="flex gap-2">
            {onOpenExisting && <Button type="button" size="sm" variant="secondary" onClick={() => onOpenExisting(product.id)}>Open it</Button>}
            {onAddVendor && <Button type="button" size="sm" onClick={() => onAddVendor(product.id)}>Add for another vendor</Button>}
          </span>
        </div>
      ))}
    </div>
  );
}
