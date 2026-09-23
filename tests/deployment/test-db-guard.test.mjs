import test from 'node:test';
import assert from 'node:assert/strict';
import { assertTestDatabase } from '../../scripts/test-db-guard.mjs';
const safe = 'postgresql://axima_test:test@127.0.0.1:55432/axima_commerce_test';
test('allows only explicit disposable database endpoints', () => {
  for (const url of [safe, safe + '?schema=public', safe.replace('127.0.0.1:55432', 'postgres-test:5432')]) {
    assert.doesNotThrow(() => assertTestDatabase({ AXIMA_TEST_DATABASE: '1', DATABASE_URL: url }));
  }
});
test('rejects unsafe targets without echoing credentials', () => {
  for (const url of [safe.replace('127.0.0.1', '89.223.70.196'), safe.replace('55432', '5432'),
    safe.replace('/axima_commerce_test', '/westside'), safe.replace('axima_test:', 'root:'),
    safe + '?host=89.223.70.196', safe + '?schema=production', safe + '?schema=public&schema=other',
    'postgresql://user:PRIVATE_SECRET@production/db', 'not-a-url']) {
    assert.throws(() => assertTestDatabase({ AXIMA_TEST_DATABASE: '1', DATABASE_URL: url }), error => {
      assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
      return /Refusing test database access/.test(error.message);
    });
  }
  assert.throws(() => assertTestDatabase({ DATABASE_URL: safe }));
  assert.throws(() => assertTestDatabase({ AXIMA_TEST_DATABASE: '1' }));
});
