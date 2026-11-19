import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canAccessPermissions } from '../src/store/permission-access.mjs';

const navigation = readFileSync(new URL('../src/components/common/navigation.js', import.meta.url), 'utf8');
const permissionOptions = readFileSync(
  new URL('../src/app/roles/manage/permission-options.js', import.meta.url), 'utf8',
);
const reportScreen = readFileSync(
  new URL('../src/components/reports/report-screen.jsx', import.meta.url), 'utf8',
);

test('Attendance Report sidebar visibility is controlled by its page read permission', () => {
  assert.match(permissionOptions, /row\('reports\.attendance', 'Attendance Report'\)/);
  assert.match(navigation, /label: 'Attendance Report'.*permissions: \['reports\.attendance:read'\]/);
  assert.match(navigation, /'\/reports\/attendance': 'reports\.attendance'/);
  assert.match(reportScreen, /reports\.attendance:write/);
  assert.match(reportScreen, /actions=\{canExport \?/);
  assert.equal(canAccessPermissions(
    ['attendance:read'], ['reports.attendance:read'], 'reports.attendance',
  ), false);
  assert.equal(canAccessPermissions(
    ['reports.attendance:read'], ['reports.attendance:read'], 'reports.attendance',
  ), true);
  assert.equal(canAccessPermissions(
    ['reports.attendance:write'], ['reports.attendance:read'], 'reports.attendance',
  ), true);
});
