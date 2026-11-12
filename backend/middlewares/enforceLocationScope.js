const { isSuperAdmin, locationIdOf } = require('../utils/locationScope');

function enforceLocationScope(req, res, next) {
  if (!req.user) {
    const error = new Error('Authentication required');
    error.status = 401;
    return next(error);
  }
  if (isSuperAdmin(req.user)) {
    req.locationId = req.query.selectedOutletId || null;
    return next();
  }
  const locationId = locationIdOf(req.user.locationId);
  if (!locationId) {
    const error = new Error('User has no assigned location');
    error.status = 403;
    return next(error);
  }
  req.locationId = locationId;
  for (const source of [req.query, req.body, req.params]) {
    if (!source || typeof source !== 'object') continue;
    for (const field of ['locationId', 'outletId', 'warehouseId']) {
      if (Object.prototype.hasOwnProperty.call(source, field)) source[field] = locationId;
    }
  }
  return next();
}

module.exports = enforceLocationScope;
