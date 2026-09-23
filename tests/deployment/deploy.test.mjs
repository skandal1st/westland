import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { immutableImage, persistImage, assertAdditiveMigration } from '../../scripts/deployment-lib.mjs'
import { acquireOperationLock } from '../../scripts/operation-lock.mjs'
test('deployment accepts only immutable images and preserves env ownership/mode', () => {
  assert.equal(immutableImage('latest'), false)
  assert.equal(immutableImage('registry/app:release'), false)
  const image = 'sha256:' + 'a'.repeat(64)
  assert.equal(immutableImage(image), true)
  assert.equal(immutableImage('registry/app@' + image), true)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-deploy-test-'))
  const file = path.join(dir, '.env')
  fs.writeFileSync(file, 'NEXTAUTH_SECRET=unchanged\nAPP_IMAGE=old\n', { mode: 0o600 })
  const before = fs.statSync(file)
  persistImage(file, image)
  assert.equal(fs.readFileSync(file, 'utf8'), 'NEXTAUTH_SECRET=unchanged\nAPP_IMAGE=' + image + '\n')
  const after = fs.statSync(file)
  assert.equal(after.mode, before.mode); assert.equal(after.uid, before.uid); assert.equal(after.gid, before.gid)
  fs.unlinkSync(file); fs.rmdirSync(dir)
})
test('automatic rollback permits only narrow additive migrations', () => {
  for (const sql of ['ALTER TABLE "Store" ADD COLUMN "optional" TEXT;', '-- safe\nALTER TABLE "Store" ADD COLUMN "optional" TIMESTAMP(3);', 'CREATE INDEX "probe" ON "Store" ("name", "slug");']) assert.doesNotThrow(() => assertAdditiveMigration(sql))
  for (const sql of ['DROP TABLE "Store";', 'ALTER TABLE "Store" RENAME TO "Other";', 'ALTER TABLE "Store" ADD COLUMN "required" TEXT NOT NULL;', 'UPDATE "Store" SET name=\'other\';', 'CREATE UNIQUE INDEX "probe" ON "Store" ("name");', 'ALTER TABLE "Store" ADD COLUMN "x" TEXT; DROP TABLE "User";', 'SELECT 1;', '/* comment */', '']) assert.throws(() => assertAdditiveMigration(sql))
})
test('install/update/restore exclude one another; only backup may inherit live update lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axima-deploy-test-'))
  const lock = acquireOperationLock(dir, 'update')
  try {
    for (const action of ['install', 'update', 'backup', 'restore']) assert.throws(() => acquireOperationLock(dir, action), /locked/)
    process.env.AXIMA_DEPLOY_LOCK_TOKEN = lock.token
    acquireOperationLock(dir, 'backup').release()
    assert.throws(() => acquireOperationLock(dir, 'restore'), /Invalid delegated/)
    process.env.AXIMA_DEPLOY_LOCK_TOKEN = 'wrong'
    assert.throws(() => acquireOperationLock(dir, 'backup'), /Invalid delegated/)
  } finally { delete process.env.AXIMA_DEPLOY_LOCK_TOKEN; lock.release(); fs.rmdirSync(dir) }
})

 test('reviewed gift expansion accepts only its exact additive artifact', () => {
   const sql = fs.readFileSync(new URL('../../prisma/migrations/20260923200000_gift_promotions/migration.sql', import.meta.url), 'utf8')
   assert.doesNotThrow(() => assertAdditiveMigration(sql))
   assert.throws(() => assertAdditiveMigration(sql + '\nDELETE FROM "Order";'))
   assert.throws(() => assertAdditiveMigration(sql.replace('"giftSelections" JSONB', '"giftSelections" JSONB NOT NULL')))
 })

test('reviewed category banner expansion accepts only its exact artifact',()=>{
 const sql=fs.readFileSync(new URL('../../prisma/migrations/20260924010000_banner_category/migration.sql',import.meta.url),'utf8')
 assert.doesNotThrow(()=>assertAdditiveMigration(sql))
 assert.throws(()=>assertAdditiveMigration(sql+'\nDELETE FROM "Order";'))
 assert.throws(()=>assertAdditiveMigration(sql.replace('TEXT;','TEXT NOT NULL;')))
})
