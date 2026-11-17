'use client';

import { useEffect, useState } from 'react';
import { Select } from '@/components/ui';
import { getLocations } from '@/services/stock';
import { T } from '@/i18n/language-provider';

export function canSelectAccountingLocation(user) {
  return user?.role === 'Super Admin'
    || user?.permissions?.includes('*')
    || Boolean(user?.canViewAllLocations);
}

export function accountingLocationParam(user, selectedLocationId) {
  if (!canSelectAccountingLocation(user)) {
    const assigned = user?.locationId?._id || user?.locationId;
    return assigned ? String(assigned) : '';
  }
  return selectedLocationId === 'all' ? '' : selectedLocationId;
}

export function useAccountingLocations(token, user) {
  const canSelect = canSelectAccountingLocation(user);
  const [locations, setLocations] = useState([]);
  const [loadingLocations, setLoadingLocations] = useState(false);
  const [locationError, setLocationError] = useState('');

  useEffect(() => {
    if (!token || !canSelect) {
      setLocations([]);
      setLoadingLocations(false);
      setLocationError('');
      return undefined;
    }

    let active = true;
    setLoadingLocations(true);
    setLocationError('');
    getLocations(token).then(({ data }) => {
      if (active) setLocations(data.locations.filter((location) => location.isActive));
    }).catch((error) => {
      if (active) setLocationError(error.response?.data?.message || 'Unable to load locations.');
    }).finally(() => {
      if (active) setLoadingLocations(false);
    });

    return () => { active = false; };
  }, [canSelect, token]);

  return { canSelect, locations, loadingLocations, locationError };
}

export default function AccountingLocationFilter({
  canSelect, locations, loading, value, onChange,
}) {
  if (!canSelect) return null;
  return (
    <Select label="Location" name="locationId" value={value} disabled={loading} onChange={(event) => onChange(event.target.value)}>
      <option value="all"><T>{"All locations"}</T></option>
      {locations.map((location) => (
        <option key={location.id} value={location.id}>{location.name} · {location.type}</option>
      ))}
    </Select>
  );
}
