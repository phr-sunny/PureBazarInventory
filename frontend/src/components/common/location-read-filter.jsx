'use client';

import { Badge, Select } from '@/components/ui';
import { T } from '@/i18n/language-provider';

export default function LocationReadFilter({
  locations, selectedOutletId, onChange, label = 'Location', canSelectLocation = true, locationName,
}) {
  if (!canSelectLocation) {
    return (
      <Badge tone="neutral">
        <T>{"Location"}</T>: {locationName || 'No location assigned'}
      </Badge>
    );
  }

  return (
    <div className="w-full max-w-sm">
      <Select label={label} name="selectedOutletId" value={selectedOutletId} onChange={onChange}>
        <option value="all"><T>{"All"}</T></option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>{location.name}</option>
        ))}
      </Select>
    </div>
  );
}
