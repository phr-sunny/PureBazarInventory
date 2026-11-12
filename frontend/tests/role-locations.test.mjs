import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import locationUtils from '../src/app/roles/users/location-utils.cjs';

const { eligibleLocations, locationForRole, userPayload } = locationUtils;
const locations = [
  { id: 'central', name: 'Central Warehouse', type: 'CENTRAL', isActive: true },
  { id: 'outlet', name: 'Outlet', type: 'OUTLET', isActive: true },
  { id: 'closed', name: 'Closed', type: 'OUTLET', isActive: false },
];
const warehouse = { name: 'Stock manager', allowedLocationType: 'warehouse' };
const outlet = { name: 'Cashier', allowedLocationType: 'outlet' };
const any = { name: 'Team member', allowedLocationType: 'any' };
const admin = { name: 'Super Admin', allowedLocationType: 'any' };
const ids = (role) => eligibleLocations(role, locations).map((location) => location.id);

test('location choices respect role type and active status', () => {
  assert.deepEqual(ids(warehouse), ['central']);
  assert.deepEqual(ids(outlet), ['outlet']);
  assert.deepEqual(ids(any), ['central', 'outlet']);
  assert.deepEqual(ids({ name: 'Legacy role' }), ['central', 'outlet']);
  assert.deepEqual(ids(admin), []);
  assert.deepEqual(ids({ name: 'Legacy admin', permissions: ['*'] }), []);
  assert.deepEqual(eligibleLocations(warehouse, [{ ...locations[0], isActive: false }]).map((item) => item.id), ['central']);
});

test('role changes retain only compatible locations', () => {
  assert.equal(locationForRole(any, locations, 'outlet'), 'outlet');
  assert.equal(locationForRole(warehouse, locations, 'outlet'), '');
  assert.equal(locationForRole(outlet, locations, 'closed'), '');
  assert.equal(locationForRole(admin, locations, 'outlet'), '');
});

test('user payload clears location for Super Admin and preserves other fields', () => {
  const form = { name: 'A User', roleId: 'role', locationId: 'central', password: '' };
  assert.deepEqual(userPayload(form, warehouse), { name: 'A User', roleId: 'role', locationId: 'central' });
  assert.deepEqual(userPayload(form, admin), { name: 'A User', roleId: 'role', locationId: null });
  assert.equal(userPayload({ ...form, password: 'password' }, outlet).password, 'password');
});

test('role and user forms connect location controls to their payloads', () => {
  const rolePage = readFileSync(new URL('../src/app/roles/manage/page.jsx', import.meta.url), 'utf8');
  const userPage = readFileSync(new URL('../src/app/roles/users/page.jsx', import.meta.url), 'utf8');
  assert.match(rolePage, /allowedLocationType: form\.allowedLocationType/);
  assert.ok(rolePage.indexOf('label="Works at"') > rolePage.indexOf('permissionGroups.map'));
  assert.match(userPage, /!isSuperAdmin\(selectedRole\).*&&/);
  assert.ok(userPage.split('\n').some((line) => line.includes('<Select label="Location"') && line.includes('required')));
  assert.match(userPage, /userPayload\(form, selectedRole\)/);
  assert.match(userPage, /user\.location\?\.name/);
});
