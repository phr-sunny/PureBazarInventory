'use client';

import { Badge, Input, Select } from '@/components/ui';
import { T } from '@/i18n/language-provider';

const reasons = ['Damaged', 'Expired', 'Lost or stolen', 'Found extra stock', 'Data entry correction', 'Other'];

export default function StockAdjustmentFields({
  isSuperAdmin, user, locations, warehouseId, onLocationChange,
  mode, onModeChange, reason, onReasonChange, reasonNote, onReasonNoteChange,
}) {
  return (
    <>
      <div className="grid gap-4 md:grid-cols-2">
        {isSuperAdmin ? (
          <Select label="Warehouse or outlet" name="warehouseId" value={warehouseId} onChange={onLocationChange}>
            <option value=""><T>{"Choose a location"}</T></option>
            {locations.map((location) => <option key={location.id} value={location.id}>{location.name}</option>)}
          </Select>
        ) : (
          <div className="space-y-2">
            <span className="block text-sm font-medium text-slate-700"><T>{"Location"}</T></span>
            <Badge tone="neutral">{user?.location?.name || locations.find((item) => item.id === warehouseId)?.name || 'No location assigned'}</Badge>
          </div>
        )}
        <Select label="Adjustment mode" name="mode" value={mode} onChange={onModeChange}>
          <option value="REMOVE"><T>{"Remove stock"}</T></option>
          <option value="ADD"><T>{"Add stock"}</T></option>
        </Select>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Select label="Reason" name="reason" value={reason} onChange={onReasonChange} required>
          <option value=""><T>{"Choose a reason"}</T></option>
          {reasons.map((item) => <option key={item} value={item}>{item}</option>)}
        </Select>
        {reason === 'Other' && <Input label="Reason note" name="reasonNote" value={reasonNote} onChange={onReasonNoteChange} maxLength={500} required placeholder="Add a short note" />}
      </div>
    </>
  );
}
