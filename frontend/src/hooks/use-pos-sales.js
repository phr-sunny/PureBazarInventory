'use client';

import { useCallback, useEffect, useState } from 'react';
import useAuth from '@/store/use-auth';
import { getSalesHistory } from '@/services/pos-admin';
import { buildSalesHistoryParams } from '@/services/pos-screen-utils.cjs';

export default function usePosSales(selectedOutletId, { allowAllLocations = false } = {}) {
  const {
    initialized, token, user, hasPermission,
  } = useAuth();
  const canRead = hasPermission('pos:read');
  const isSuperAdmin = user?.role === 'Super Admin' || user?.permissions?.includes('*');
  const canSelectOutlet = isSuperAdmin || (allowAllLocations && Boolean(user?.canViewAllLocations));
  const canReadAllLocations = allowAllLocations && canSelectOutlet;
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadOrders = useCallback(async (filters = {}) => {
    if (canSelectOutlet && !selectedOutletId && !canReadAllLocations) {
      setOrders([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { data } = await getSalesHistory({
        ...buildSalesHistoryParams(filters),
        ...(canSelectOutlet && selectedOutletId && selectedOutletId !== 'all' ? { selectedOutletId } : {}),
      });
      setOrders(data.orders);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load sales history.');
    } finally {
      setLoading(false);
    }
  }, [canReadAllLocations, canSelectOutlet, selectedOutletId]);

  useEffect(() => {
    if (!initialized) return;
    if (!token || !canRead) {
      setLoading(false);
      return;
    }
    loadOrders();
  }, [canRead, initialized, loadOrders, token]);

  return {
    orders,
    loading,
    error,
    canRead,
    loadOrders,
  };
}
