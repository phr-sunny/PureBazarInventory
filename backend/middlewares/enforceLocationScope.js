const { isSuperAdmin, locationIdOf } = require('../utils/locationScope');
const { Location } = require('../models');
const mongoose = require('mongoose');

function createLocationScopeMiddleware({
  outletOnly = false,
  allowCentralLocationSelection = false,
} = {}) {
  return async function locationScopeMiddleware(req, res, next) {
    try {
      if (!req.user) {
        const error = new Error('Authentication required');
        error.status = 401;
        throw error;
      }

      const superAdmin = isSuperAdmin(req.user);
      const assignedLocationId = locationIdOf(req.user.locationId);
      const canSelectLocation = superAdmin
        || (allowCentralLocationSelection && req.user.location?.type === 'CENTRAL');
      const selectedLocationId = outletOnly
        ? req.query.selectedOutletId || null
        : req.query.selectedOutletId || req.query.warehouseId || req.body?.warehouseId || null;
      const locationId = canSelectLocation && selectedLocationId
        ? selectedLocationId
        : (superAdmin ? null : assignedLocationId);

      if (!locationId && (!superAdmin || outletOnly)) {
        const error = new Error(superAdmin && outletOnly
          ? 'Select an outlet to use POS'
          : 'User has no assigned location');
        error.status = superAdmin && outletOnly ? 400 : 403;
        throw error;
      }

      if (allowCentralLocationSelection && canSelectLocation && selectedLocationId) {
        if (!mongoose.isValidObjectId(locationId)) {
          const error = new Error('Select a valid location');
          error.status = 400;
          throw error;
        }
        const location = await Location.findById(locationId).select('_id type isActive').lean();
        if (!location || location.isActive === false || !['CENTRAL', 'OUTLET'].includes(location.type)) {
          const error = new Error('Select an active location');
          error.status = 400;
          throw error;
        }
      }

      if (outletOnly) {
        if (!mongoose.isValidObjectId(locationId)) {
          const error = new Error(superAdmin ? 'Select a valid outlet to use POS' : 'POS is only available to users assigned to an active outlet');
          error.status = superAdmin ? 400 : 403;
          throw error;
        }
        const location = await Location.findById(locationId).lean();
        if (!location || location.type !== 'OUTLET' || location.isActive === false) {
          const error = new Error(superAdmin
            ? 'Select an active outlet to use POS'
            : 'POS is only available to users assigned to an active outlet');
          error.status = superAdmin ? 400 : 403;
          throw error;
        }
      }

      req.locationId = locationId;
      req.locationType = req.user.location?.type || null;
      if (!superAdmin && !(allowCentralLocationSelection && req.locationType === 'CENTRAL')) {
        for (const source of [req.query, req.body, req.params]) {
          if (!source || typeof source !== 'object') continue;
          for (const field of ['locationId', 'outletId', 'warehouseId']) {
            if (Object.prototype.hasOwnProperty.call(source, field)) {
              source[field] = locationId == null ? null : locationId.toString();
            }
          }
        }
      }
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

const enforceLocationScope = createLocationScopeMiddleware();
enforceLocationScope.forOutlet = createLocationScopeMiddleware({ outletOnly: true });
enforceLocationScope.forStockRead = createLocationScopeMiddleware({ allowCentralLocationSelection: true });
enforceLocationScope.forStockCounts = createLocationScopeMiddleware({ allowCentralLocationSelection: true });

module.exports = enforceLocationScope;
