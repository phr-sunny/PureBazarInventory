const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { AuditLog, User } = require('../models');
const { expandPermissions } = require('../config/permissionCatalog');
const { isSuperAdmin, locationIdOf } = require('../utils/locationScope');

const DUMMY_HASH = bcrypt.hashSync('purebazar-dummy-password', 10);

function publicUser(user) {
  const role = user.roleId && typeof user.roleId === 'object' ? user.roleId : null;
  const admin = isSuperAdmin({ roleId: role });
  const location = user.locationId?.name ? user.locationId : null;
  return {
    id: user._id.toString(),
    name: user.name,
    email: user.email,
    role: role?.name || null,
    roleId: role?._id?.toString() || user.roleId?.toString() || null,
    permissions: expandPermissions(Array.isArray(role?.permissions) ? role.permissions : []),
    locationId: admin ? null : locationIdOf(user.locationId),
    location: !admin && location ? { id: location._id.toString(), name: location.name, type: location.type } : null,
    isLocationLocked: !admin && Boolean(user.locationId),
    canViewAllLocations: admin || Boolean(role?.canViewAllLocations),
  };
}

async function login(req, res, next) {
  try {
    const email = req.body.email.trim().toLowerCase();
    const user = await User.findOne({ email }).select('+passwordHash').populate([
      { path: 'roleId' }, { path: 'locationId', select: 'name type' },
    ]);
    const hasPasswordHash = typeof user?.passwordHash === 'string' && user.passwordHash.length > 0;
    // Compare against a dummy hash when the user is unknown so response time does not reveal valid emails.
    const passwordMatches = await bcrypt.compare(
      req.body.password,
      hasPasswordHash ? user.passwordHash : DUMMY_HASH,
    ) && hasPasswordHash;

    if (!user || !passwordMatches || !user.isActive) {
      if (user) {
        await AuditLog.create({
          actorId: user._id,
          action: 'LOGIN_FAILED',
          entity: 'User',
          entityId: user._id,
          ipAddress: req.ip,
        });
      }
      const error = new Error('Invalid email or password');
      error.status = 401;
      throw error;
    }

    const token = jwt.sign({ sub: user._id.toString() }, process.env.JWT_SECRET, {
      expiresIn: '8h',
      algorithm: 'HS256',
    });
    await AuditLog.create({
      actorId: user._id,
      action: 'LOGIN',
      entity: 'User',
      entityId: user._id,
      ipAddress: req.ip,
    });

    res.set('Authorization', `Bearer ${token}`);
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, user: publicUser(user), token });
  } catch (error) {
    return next(error);
  }
}

function me(req, res) {
  res.set('Cache-Control', 'no-store');
  return res.json({ success: true, user: req.user });
}

async function logout(req, res, next) {
  try {
    await AuditLog.create({
      actorId: req.user._id,
      action: 'LOGOUT',
      entity: 'User',
      entityId: req.user._id,
      ipAddress: req.ip,
    });
    res.set('Authorization', '');
    res.set('Cache-Control', 'no-store');
    return res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    return next(error);
  }
}

module.exports = { login, me, logout };