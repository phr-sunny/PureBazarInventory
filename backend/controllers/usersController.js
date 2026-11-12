const bcrypt = require('bcryptjs');
const {
  AuditLog, Location, Role, User,
} = require('../models');
const { isSuperAdmin, locationIdOf } = require('../utils/locationScope');

function publicUser(user, resolvedLocation) {
  const role = user.roleId && typeof user.roleId === 'object' ? user.roleId : null;
  const location = resolvedLocation || (user.locationId?.name ? user.locationId : null);
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    roleId: role?._id?.toString() || user.roleId?.toString() || null,
    role: role?.name || null,
    isActive: user.isActive,
    locationId: locationIdOf(user.locationId)?.toString() || null,
    location: location ? { id: location._id.toString(), name: location.name, type: location.type } : null,
    createdAt: user.createdAt,
  };
}

function statusError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function handleError(error, next) {
  if (error.code === 11000) error.status = 409;
  return next(error);
}

async function validateLocation(role, locationId) {
  if (isSuperAdmin({ roleId: role })) {
    if (locationId) throw statusError('Super Admin cannot have a location', 400);
    return null;
  }
  if (!locationId) throw statusError('A location is required for this user', 400);
  const location = await Location.findById(locationId);
  if (!location) throw statusError('Location not found', 400);
  if (location.type === 'OUTLET' && location.isActive === false) {
    throw statusError('Location must be an active outlet', 400);
  }
  const required = { warehouse: 'CENTRAL', outlet: 'OUTLET' }[role.allowedLocationType];
  if (required && location.type !== required) throw statusError('Location type does not match the role', 400);
  return location;
}

async function list(req, res, next) {
  try {
    const users = await User.find().select('-passwordHash').populate([
      { path: 'roleId', select: 'name' }, { path: 'locationId', select: 'name type' },
    ]).sort({ name: 1 }).lean();
    return res.json({ success: true, users: users.map((user) => publicUser(user)) });
  } catch (error) {
    return next(error);
  }
}

async function create(req, res, next) {
  try {
    const role = await Role.findById(req.body.roleId);
    if (!role) throw statusError('Role not found', 400);
    if (!isSuperAdmin(req.user)) throw statusError('Only Super Admin can assign locations', 403);
    const location = await validateLocation(role, req.body.locationId);
    const locationId = location?._id;
    const user = await User.create({
      name: req.body.name,
      email: req.body.email,
      passwordHash: await bcrypt.hash(req.body.password, 12),
      roleId: role._id,
      ...(locationId ? { locationId } : {}),
      isActive: req.body.isActive ?? true,
    });
    await AuditLog.create({
      actorId: req.user._id, action: 'CREATE', entity: 'User', entityId: user._id,
      after: { name: user.name, email: user.email, roleId: String(role._id), locationId: locationId?.toString() || null, isActive: user.isActive },
      ipAddress: req.ip,
    });
    user.roleId = role;
    return res.status(201).json({ success: true, user: publicUser(user, location) });
  } catch (error) {
    return handleError(error, next);
  }
}

async function update(req, res, next) {
  try {
    const previous = await User.findById(req.params.id).populate('roleId', 'name');
    if (!previous) throw statusError('User not found', 404);
    const role = await Role.findById(req.body.roleId);
    if (!role) throw statusError('Role not found', 400);
    const hasLocation = Object.prototype.hasOwnProperty.call(req.body, 'locationId');
    if (hasLocation && !isSuperAdmin(req.user)) throw statusError('Only Super Admin can assign locations', 403);
    const locationId = hasLocation ? req.body.locationId : previous.locationId;
    const location = await validateLocation(role, locationId);
    const updates = { name: req.body.name, email: req.body.email, roleId: req.body.roleId };
    if (hasLocation) updates.locationId = location?._id || null;
    if (req.body.isActive !== undefined) updates.isActive = req.body.isActive;
    if (req.body.password) updates.passwordHash = await bcrypt.hash(req.body.password, 12);
    const user = await User.findByIdAndUpdate(req.params.id, updates, { new: true, runValidators: true })
      .populate('roleId', 'name');
    if (!user) throw statusError('User not found', 404);
    const snapshot = (doc) => ({
      name: doc.name,
      email: doc.email,
      roleId: String(doc.roleId?._id || doc.roleId),
      locationId: doc.locationId ? String(doc.locationId) : null,
      isActive: doc.isActive,
    });
    await AuditLog.create({
      actorId: req.user._id,
      action: 'UPDATE',
      entity: 'User',
      entityId: user._id,
      ...(previous ? { before: snapshot(previous) } : {}),
      after: snapshot(user),
      metadata: { passwordChanged: Boolean(req.body.password) },
      ipAddress: req.ip,
    });
    return res.json({ success: true, user: publicUser(user, location) });
  } catch (error) {
    return handleError(error, next);
  }
}

async function remove(req, res, next) {
  try {
    if (req.params.id === req.user._id.toString()) throw statusError('You cannot delete your own account', 400);
    const user = await User.findByIdAndDelete(req.params.id);
    if (!user) throw statusError('User not found', 404);
    await AuditLog.create({ actorId: req.user._id, action: 'DELETE', entity: 'User', entityId: user._id, ipAddress: req.ip });
    return res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    return handleError(error, next);
  }
}

module.exports = { list, create, update, remove };