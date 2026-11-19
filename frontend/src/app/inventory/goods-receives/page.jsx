'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSelector } from 'react-redux';
import { ArrowUpRight, Check, Plus } from 'lucide-react';
import { Badge, Button, Card, Input, Table } from '@/components/ui';
import LocationReadFilter from '@/components/common/location-read-filter';
import { approveGoodsReceive, getGoodsReceives, getLocations, getReceiveVendors } from '@/services/stock';
import { T } from '@/i18n/language-provider';
import useToastMessages from '@/hooks/use-toast-messages';

const can = (permissions, permission) => permissions.includes('*') || permissions.includes(permission);
const formatDate = (value) => new Intl.DateTimeFormat('en-BD', { dateStyle: 'medium' }).format(new Date(value));

function statusTone(status) {
  if (status === 'Approved') return 'success';
  if (status === 'Rejected') return 'danger';
  return 'warning';
}

export default function GoodsReceivesPage() {
  const { token, user, initialized } = useSelector((state) => state.auth);
  const permissions = user?.permissions || [];
  const canRead = can(permissions, 'stock:read');
  const canWrite = can(permissions, 'stock:write');
  const isSuperAdmin = user?.role === 'Super Admin';
  const canSelectLocation = isSuperAdmin || Boolean(user?.canViewAllLocations);
  const [receives, setReceives] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [locations, setLocations] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [locationsLoaded, setLocationsLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [approvingId, setApprovingId] = useState('');
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
    Promise.all([getLocations(token), getReceiveVendors(token)])
      .then(([locationResponse, vendorResponse]) => {
        if (!active) return;
        const userLocationId = String(user?.locationId?._id || user?.locationId || '');
        const availableLocations = locationResponse.data.locations.filter((location) => (
          location.isActive !== false && (canSelectLocation || location.id === userLocationId)
        ));
        setLocations(availableLocations);
        setSelectedOutletId((current) => canSelectLocation ? current || 'all' : userLocationId);
        setVendors(vendorResponse.data.vendors);
        setLocationsLoaded(true);
      })
      .catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load goods receive locations.',
      ))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [canRead, canSelectLocation, initialized, token, user?.locationId]);

  useEffect(() => {
    if (!initialized || !token || !canRead || !locationsLoaded) return undefined;
    let active = true;
    setLoading(true);
    getGoodsReceives(token, canSelectLocation && selectedOutletId !== 'all' ? selectedOutletId : undefined)
      .then((response) => active && setReceives(response.data.goodsReceives))
      .catch((requestError) => active && setError(
        requestError.response?.data?.message || 'Unable to load goods receives.',
      ))
      .finally(() => active && setLoading(false));
    return () => { active = false; };
  }, [canRead, canSelectLocation, initialized, locationsLoaded, selectedOutletId, token]);

  const vendorNames = useMemo(
    () => new Map(vendors.map((vendor) => [vendor.id, vendor.name])),
    [vendors],
  );
  const visibleReceives = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return receives;
    return receives.filter((receive) => (
      `${receive.vendorChallanNumber || ''} ${vendorNames.get(receive.vendorId) || receive.vendorId || ''} ${receive.status}`
        .toLowerCase().includes(query)
    ));
  }, [receives, search, vendorNames]);

  async function approve(id) {
    setApprovingId(id);
    setError('');
    try {
      const response = await approveGoodsReceive(token, id);
      setReceives((current) => current.map((receive) => (
        receive.id === id ? response.data.goodsReceive : receive
      )));
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to approve this GRN.');
    } finally {
      setApprovingId('');
    }
  }

  const columns = [
    {
      key: 'id',
      label: 'GRN / Date',
      render: (id, receive) => (
        <div><strong className="block text-slate-800">{id.slice(-8).toUpperCase()}</strong><small className="text-slate-500">{formatDate(receive.createdAt)}</small></div>
      ),
    },
    { key: 'vendorId', label: 'Vendor', render: (id) => vendorNames.get(id) || '—' },
    { key: 'vendorChallanNumber', label: 'Challan', render: (value) => value || '—' },
    { key: 'lines', label: 'Products', render: (lines) => lines.length },
    { key: 'status', label: 'Status', render: (status) => <Badge tone={statusTone(status)}>{status}</Badge> },
    {
      key: 'actions',
      label: 'Actions',
      render: (_, receive) => (
        <div className="flex items-center gap-2">
          {canWrite && receive.status === 'Draft'
            && (isSuperAdmin || receive.warehouseId === String(user?.locationId?._id || user?.locationId || '')) && (
            <Button size="sm" onClick={() => approve(receive.id)} disabled={approvingId === receive.id}>
              <Check size={15} /> {approvingId === receive.id ? 'Approving...' : 'Approve'}
            </Button>
          )}
          <Link className="ui-button button-secondary button-sm" href={`/inventory/goods-receives/${receive.id}/print`}>
            Print <ArrowUpRight size={14} />
          </Link>
        </div>
      ),
    },
  ];

  if (!initialized || loading) return <p role="status" className="py-10 text-center text-sm text-slate-500"><T>{"Loading goods receives..."}</T></p>;
  if (!token || !canRead) return <p role="alert" className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800"><T>{"You do not have permission to view goods receives."}</T></p>;

  return (
    <section className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase text-slate-500"><T>{"Inventory"}</T></p>
          <h1 className="text-2xl font-semibold text-slate-900"><T>{"Goods Receive"}</T></h1>
          <p className="mt-1 text-sm text-slate-600"><T>{"Create, review, approve, and print goods receipts for your location."}</T></p>
        </div>
        {canWrite && <Link href="/inventory/goods-receives/new" className="ui-button button-primary button-md"><Plus size={17} /> <T>{"New GRN"}</T></Link>}
      </div>
      <LocationReadFilter
        label="Receive location"
        locations={locations}
        selectedOutletId={selectedOutletId}
        onChange={(event) => setSelectedOutletId(event.target.value)}
        canSelectLocation={canSelectLocation}
        locationName={user?.location?.name}
      />
      <Card title="Goods Receive Notes" description={`${receives.length} GRN${receives.length === 1 ? '' : 's'}${canSelectLocation && selectedOutletId !== 'all' && locations.find((item) => item.id === selectedOutletId) ? ` at ${locations.find((item) => item.id === selectedOutletId).name}` : ''}`}>
        <div className="mb-4 max-w-sm">
          <Input label="Search GRNs" name="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Challan, vendor, or status" />
        </div>
        <Table columns={columns} rows={visibleReceives} rowKey="id" emptyMessage={search ? 'No GRNs match your search.' : 'No goods receives yet.'} />
      </Card>
    </section>
  );
}
