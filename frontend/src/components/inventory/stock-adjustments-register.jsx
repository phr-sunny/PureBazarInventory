'use client';

import { Badge, Button, Card, Table } from '@/components/ui';
import LocationReadFilter from '@/components/common/location-read-filter';
import { formatSignedStock } from '@/services/stock-units.cjs';

const recordId = (record) => String(record.id || record._id);
const statusTone = { Approved: 'success', Pending: 'warning', Rejected: 'danger' };
const money = (value) => new Intl.NumberFormat('en-BD', {
  style: 'currency',
  currency: 'BDT',
}).format(Number(value) || 0);

export default function StockAdjustmentsRegister({
  adjustments, locations, productsById, selectedOutletId, canSelectLocation, user, onLocationChange, onDecision,
}) {
  const columns = [
    {
      key: '_id',
      label: 'Adjustment',
      render: (id, item) => <div><strong>{recordId(item).slice(-8).toUpperCase()}</strong><small className="block text-slate-500">{new Date(item.createdAt).toLocaleString()}</small></div>,
    },
    { key: 'warehouseId', label: 'Location', render: (id) => locations.find((item) => item.id === String(id))?.name || 'Location' },
    { key: 'reason', label: 'Reason' },
    { key: 'lines', label: 'Lines', render: (items) => items.map((line) => {
      const product = productsById.get(String(line.productId));
      return `${line.productName || product?.name || String(line.productId).slice(-6)} (${formatSignedStock(
        line.quantity,
        line.unitsPerPackage || product?.unitsPerPackage,
        line.packageUnitName || product?.packageUnitName,
      )})`;
    }).join(', ') },
    { key: 'value', label: 'Value', render: money },
    { key: 'status', label: 'Status', render: (status) => <Badge tone={statusTone[status] || 'neutral'}>{status}</Badge> },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, item) => item.status === 'Pending' && user?.role === 'Super Admin' ? (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => onDecision(item, true)}>Approve</Button>
          <Button size="sm" variant="secondary" onClick={() => onDecision(item, false)}>Reject</Button>
        </div>
      ) : '—',
    },
  ];

  return (
    <Card title="Adjustment register" description={`${adjustments.length} adjustment${adjustments.length === 1 ? '' : 's'} ${canSelectLocation && selectedOutletId === 'all' ? 'across all locations' : 'in your location scope'}`}>
      <div className="mb-4">
        <LocationReadFilter
          locations={locations}
          selectedOutletId={selectedOutletId}
          onChange={onLocationChange}
          canSelectLocation={canSelectLocation}
          locationName={user?.location?.name}
        />
      </div>
      <Table columns={columns} rows={adjustments} rowKey="_id" emptyMessage="No stock adjustments yet." />
    </Card>
  );
}
