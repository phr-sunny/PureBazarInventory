function isSuperAdmin(user) {
  const role = typeof user?.role === 'object' ? user.role : user?.roleId;
  const name = typeof user?.role === 'string' ? user.role : role?.name;
  const permissions = user?.permissions || role?.permissions || [];
  return name === 'Super Admin' || permissions.includes('*');
}

function locationIdOf(location) {
  return location?._id || location || null;
}

module.exports = { isSuperAdmin, locationIdOf };
