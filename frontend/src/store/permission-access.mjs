export function canAccessPermissions(granted, requiredPermissions = [], pageKey, role) {
  const pageAware = pageKey
    && granted.some((permission) => /^[a-z]+\.[a-z-]+:(read|write)$/.test(permission));
  if (pageAware && !granted.includes('*')) {
    return granted.includes(`${pageKey}:read`) || granted.includes(`${pageKey}:write`);
  }
  return requiredPermissions.length === 0
    || requiredPermissions.some((permission) => permission === '*'
      ? role === 'Super Admin' && granted.includes('*')
      : granted.includes('*') || granted.includes(permission));
}
