'use client';

import { useCallback, useEffect, useState } from 'react';
import useAuth from '@/store/use-auth';
import { getSalesHistory } from '@/services/pos-admin';
import { buildSalesHistoryParams } from '@/services/pos-screen-utils.cjs';

export default function usePosSales(selectedOutletId) {
  const {
    initialized, token, user, hasPermission,
  } = useAuth();
  const canRead = hasPermission('pos:read');
  const isSuperAdmin = user?.role === 'Super Admin' || user?.permissions?.includes('*');
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const loadOrders = useCallback(async (filters = {}) => {
    if (isSuperAdmin && !selectedOutletId) {
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
        ...(isSuperAdmin ? { selectedOutletId } : {}),
      });
      setOrders(data.orders);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load sales history.');
    } finally {
      setLoading(false);
    }
  }, [isSuperAdmin, selectedOutletId]);

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
