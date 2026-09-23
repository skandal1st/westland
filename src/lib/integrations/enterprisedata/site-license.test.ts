import { afterEach, expect, it, vi } from 'vitest'
import { siteTransport } from './site-transport'
import type { FileTransport } from './http-files'
import type { PrismaClient } from '@prisma/client'
import * as runtime from '@/lib/license/runtime'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it.each(['UploadData', 'GetFilePart', 'PutFilePart', 'DownloadData'])('blocks ED %s before touching files, outbox or receipt state', async operation => {
  vi.stubEnv('LICENSE_ENFORCE', '1')
  vi.spyOn(runtime, 'reloadLicenseState').mockReturnValue({ status: 'INVALID', modules: [] })
  const touched = vi.fn(() => { throw new Error('unexpected IO') })
  const files = new Proxy({}, { get: touched }) as FileTransport
  const db = new Proxy({}, { get: touched }) as PrismaClient
  await expect(siteTransport(files, { storeId: 'store', connectionId: 'source' }, db).handle(operation, new URLSearchParams()))
    .rejects.toMatchObject({ status: 403, code: 'license_invalid' })
  expect(touched).not.toHaveBeenCalled()
})
