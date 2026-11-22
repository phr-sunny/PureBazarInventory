'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSelector } from 'react-redux';
import { Search } from 'lucide-react';
import { Badge, Card, Input, Select, Table } from '@/components/ui';
import { formatStock } from '@/services/stock-units.cjs';
import { getLocations, getWarehouseStock } from '@/services/stock';
import { T } from '@/i18n/language-provider';
import useToastMessages from '@/hooks/use-toast-messages';
import CameraBarcodeScanner from '@/components/common/camera-barcode-scanner';

const can = (permissions, permission) => permissions.includes('*') || permissions.includes(permission);

export default function WarehousePage() {
  const { token, user, initialized } = useSelector((state) => state.auth);
  const canRead = can(user?.permissions || [], 'stock:read');
  const isSuperAdmin = user?.role === 'Super Admin';
  const canChooseLocation = isSuperAdmin || user?.location?.type === 'CENTRAL';
  const assignedLocationId = String(user?.locationId?._id || user?.locationId || '');
  const [location, setLocation] = useState(null);
  const [locations, setLocations] = useState([]);
  const [stock, setStock] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useToastMessages({ error });
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!initialized) return undefined;
    if (!token || !canRead) {
      setLoading(false);
      return undefined;
    }
    let active = true;
    getLocations(token)
      .then((response) => {
        const availableLocations = response.data.locations.filter((item) => (
          item.isActive !== false && (canChooseLocation || item.id === assignedLocationId)
        ));
        if (!availableLocations.length) {
          throw new Error(isSuperAdmin
            ? 'No active locations are available.'
            : 'Your assigned location is not available.');
        }
        const selected = availableLocations.find(({ id }) => id === assignedLocationId)
          || availableLocations.find(({ type }) => type === 'CENTRAL')
          || availableLocations[0];
        if (!active) return;
        setLocations(availableLocations);
        setLocation(selected);
      })
      .catch((requestError) => active && setError(
        requestError.response?.data?.message || requestError.message || 'Unable to load location stock.',
      ))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [assignedLocationId, canChooseLocation, canRead, initialized, isSuperAdmin, token]);

  useEffect(() => {
    if (!token || !location?.id) return undefined;
    let active = true;
    setStock([]);
    getWarehouseStock(token, location.id)
      .then((response) => active && setStock(response.data.stock))
      .catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load location stock.',
      ));
    return () => { active = false; };
  }, [location?.id, token]);

  const visibleStock = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return stock;
    return stock.filter((item) => `${item.productName} ${item.barcode} ${(item.barcodes || []).join(' ')}`.toLowerCase().includes(query));
  }, [search, stock]);

  const columns = [
    { key: 'productName', label: 'Product' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'vendorName', label: 'Vendor', render: (name) => name ? <Badge tone="info">{name}</Badge> : '—' },
    {
      key: 'ownerType',
      label: 'Owner',
      render: (ownerType) => <Badge tone={ownerType === 'VENDOR' ? 'info' : 'neutral'}>{ownerType === 'VENDOR' ? 'Vendor' : 'Company'}</Badge>,
    },
    { key: 'quantity', label: 'Current stock', render: (quantity, item) => <strong className="text-slate-900">{formatStock(quantity, item.unitsPerPackage, item.packageUnitName)}</strong> },
  ];

  if (!initialized || loading) return <p role="status" className="py-10 text-center text-sm text-slate-500"><T>{"Loading Central Warehouse stock..."}</T></p>;
  if (!token || !canRead) return <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><T>{"You do not have permission to view warehouse stock."}</T></p>;

  return (
    <section className="space-y-5">
      <div>
        <p className="mb-1 text-xs font-semibold uppercase text-slate-500"><T>{"Inventory"}</T></p>
        <h1 className="text-2xl font-semibold text-slate-900">{location?.name || 'Location'} Stock</h1>
        <p className="mt-1 text-sm text-slate-600"><T>{"Current balance is calculated from approved stock movements."}</T></p>
      </div>
      {canChooseLocation && (
        <div className="max-w-sm">
          <Select
            label="Stock location"
            name="warehouseId"
            value={location?.id || ''}
            onChange={(event) => setLocation(locations.find((item) => item.id === event.target.value) || null)}
          >
            {locations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </Select>
        </div>
      )}
      <Card title="Stock on hand" description={`${stock.length} products with stock movement history`}>
        <div className="mb-4 flex max-w-xl items-end gap-2">
          <Input label="Search stock" name="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Product name or barcode" />
          <CameraBarcodeScanner onScan={setSearch} />
          <Search size={16} aria-hidden="true" className="pointer-events-none relative -mt-7 ml-auto mr-3 text-slate-400" />
        </div>
        <Table columns={columns} rows={visibleStock} rowKey="productId" emptyMessage={search ? 'No stock items match your search.' : 'No stock movement has been recorded for this warehouse.'} />
      </Card>
    </section>
  );
}
