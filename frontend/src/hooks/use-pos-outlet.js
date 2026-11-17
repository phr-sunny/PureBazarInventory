'use client';

import { useEffect, useState } from 'react';
import useAuth from '@/store/use-auth';
import { getLocations } from '@/services/stock';

export default function usePosOutlet({ allowAllLocations = false } = {}) {
  const { token, user } = useAuth();
  const isSuperAdmin = user?.role === 'Super Admin' || user?.permissions?.includes('*');
  const canSelectOutlet = isSuperAdmin || (allowAllLocations && Boolean(user?.canViewAllLocations));
  const [outlets, setOutlets] = useState([]);
  const [selectedOutletId, setSelectedOutletId] = useState('');
  const [loadingOutlets, setLoadingOutlets] = useState(false);
  const [outletError, setOutletError] = useState('');

  useEffect(() => {
    if (!canSelectOutlet || !token) {
      setOutlets([]);
      setSelectedOutletId('');
      setLoadingOutlets(false);
      setOutletError('');
      return undefined;
    }

    let active = true;
    setLoadingOutlets(true);
    setOutletError('');
    getLocations(token, 'OUTLET').then(({ data }) => {
      if (!active) return;
      const activeOutlets = data.locations.filter((location) => location.isActive);
      setOutlets(activeOutlets);
      setSelectedOutletId((current) => (
        current === 'all' && allowAllLocations
          ? current
          : activeOutlets.some((location) => location.id === current) ? current : (allowAllLocations ? 'all' : '')
      ));
    }).catch((error) => {
      if (active) setOutletError(error.response?.data?.message || 'Unable to load active outlets.');
    }).finally(() => {
      if (active) setLoadingOutlets(false);
    });

    return () => { active = false; };
  }, [allowAllLocations, canSelectOutlet, token]);

  return {
    isSuperAdmin,
    canSelectOutlet,
    outlets,
    selectedOutletId,
    setSelectedOutletId,
    loadingOutlets,
    outletError,
  };
}
