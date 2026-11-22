'use client';

import { useEffect, useState } from 'react';
import { Button, Input, Modal, Select } from '@/components/ui';

export default function AddVendorProductModal({
  open, product, vendors, onClose, onSubmit,
}) {
  const [vendorId, setVendorId] = useState('');
  const [vendorPrice, setVendorPrice] = useState('');
  const [mrp, setMrp] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const mrpChanged = product && mrp !== '' && Number(mrp) !== Number(product.mrp);

  useEffect(() => {
    if (!open || !product) return;
    setVendorId('');
    setVendorPrice(String(product.vendorPrice ?? ''));
    setMrp(String(product.mrp ?? ''));
    setError('');
  }, [open, product]);

  async function submit(event) {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await onSubmit(product.id, {
        vendorId,
        vendorPrice: Math.round((Number(vendorPrice) + Number.EPSILON) * 100) / 100,
        mrp: Math.round((Number(mrp) + Number.EPSILON) * 100) / 100,
      });
      onClose();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to add this vendor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Add vendor copy">
      <form className="space-y-4" onSubmit={submit}>
        <p className="text-sm text-slate-600">Create a vendor-specific copy of {product?.name}, keeping its product details and barcodes.</p>
        <Select label="Vendor" value={vendorId} onChange={(event) => setVendorId(event.target.value)} required>
          <option value="">Select vendor</option>
          {vendors.filter((vendor) => vendor.status === 'Active').map((vendor) => (
            <option key={vendor.id} value={vendor.id}>{vendor.shopName || vendor.name}</option>
          ))}
        </Select>
        <Input label="Vendor price (৳)" type="number" min="0" step="0.01" value={vendorPrice} onChange={(event) => setVendorPrice(event.target.value)} required />
        <Input label="MRP (৳)" type="number" min="0" step="0.01" value={mrp} onChange={(event) => setMrp(event.target.value)} required />
        {mrpChanged && <p role="status" className="text-sm text-amber-800">The MRP differs from the existing product's MRP. Confirm this vendor-specific price.</p>}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={saving || !vendorId || Number(mrp) < Number(vendorPrice)}>
            {saving ? 'Saving...' : 'Create vendor copy'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
