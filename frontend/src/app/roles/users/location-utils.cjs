function isSuperAdmin(role) {
  return role?.name === 'Super Admin' || role?.permissions?.includes('*');
}

function eligibleLocations(role, locations) {
  if (!role || isSuperAdmin(role)) return [];
  const allowed = role.allowedLocationType || 'any';
  return locations.filter((location) => {
    if (location.type === 'CENTRAL') return allowed === 'any' || allowed === 'warehouse';
    if (location.type === 'OUTLET') return location.isActive !== false && (allowed === 'any' || allowed === 'outlet');
    return false;
  });
}

function locationForRole(role, locations, locationId) {
  return eligibleLocations(role, locations).some((location) => location.id === locationId) ? locationId : '';
}

function userPayload(form, role) {
  const payload = { ...form, locationId: isSuperAdmin(role) ? null : form.locationId };
  if (!payload.password) delete payload.password;
  return payload;
}

module.exports = { isSuperAdmin, eligibleLocations, locationForRole, userPayload };
