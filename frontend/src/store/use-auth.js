'use client';

import { useDispatch, useSelector } from 'react-redux';
import { loginUser, logoutUser } from './auth-slice';
import { canAccessPermissions } from './permission-access.mjs';

export default function useAuth() {
  const dispatch = useDispatch();
  const auth = useSelector((state) => state.auth);

  function hasPermission(permission) {
    const permissions = auth.user?.permissions || [];
    return permissions.includes('*') || permissions.includes(permission);
  }

  function canAccess(requiredPermissions = [], pageKey) {
    return canAccessPermissions(
      auth.user?.permissions || [],
      requiredPermissions,
      pageKey,
      auth.user?.role,
    );
  }

  return {
    ...auth,
    hasPermission,
    canAccess,
    login: (credentials) => dispatch(loginUser(credentials)).unwrap(),
    logout: () => dispatch(logoutUser()).unwrap().then(() => {
      window.sessionStorage.removeItem('purebazar.authToken');
    }),
  };
}
