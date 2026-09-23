import { assertCapability, CapabilityError } from '@/lib/capabilities'
import { LicenseError } from '@/lib/license'
import { z } from 'zod'
import { EnterpriseDataError } from './message'
import { importDirectory } from './directory'
import type { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/db'
import { IntegrationInputError } from '../errors'
import type { FileTransport } from './http-files'
import { SetupError } from './http-setup'
import { acknowledgeSiteOrders, prepareSiteOrder, requireEdSource, requirePendingDeliveries, type SiteBinding } from './site-orders'
/** Auth runs in the HTTP server first. This fixed binding cannot be overridden by a URL parameter. */
export function siteTransport(files: FileTransport, binding: SiteBinding, db: PrismaClient = prisma, directoryEnabled = false) {
  let tail: Promise<unknown> = Promise.resolve()
  return {
    handle(operation: string, query: URLSearchParams, body?: Buffer) {
      const task = tail.then(async () => {
        try {
          assertCapability('commerce-core')
          files.validateRequest(operation, query, body)
          await requireEdSource(binding, db)
          const before = files.siteStatus(binding)
          await acknowledgeSiteOrders(binding, before.receipts, db)
          if (['UploadData', 'PrepareGetFile', 'GetFilePart'].includes(operation)) await requirePendingDeliveries(binding, before.pendingDeliveries, db)
          if (operation === 'UploadData' && !before.pending) {
            const delivery = await prepareSiteOrder(binding, before.namespace, db)
            if (delivery) files.queueSiteOrder(binding, delivery)
          }
          let result
          try { result = files.handle(operation, query, body) }
          catch (error) {
            if (!directoryEnabled || !(error instanceof SetupError) || error.code !== 'ed_business_payload_saved_not_applied' || !['DownloadData', 'PutMessageForDataMatching'].includes(operation)) throw error
            const staged = files.stagedBusinessMessage(query.get('FileID') ?? '')
            const receipt = await importDirectory(binding, staged.peer, staged.xml, db)
            files.acceptBusinessMessage(receipt.sha256)
            result = files.handle(operation, query, body)
          }
          await acknowledgeSiteOrders(binding, files.siteStatus(binding).receipts, db)
          return result
        } catch (error) {
          if (error instanceof LicenseError || error instanceof CapabilityError) throw new SetupError(403, error.message)
          if (error instanceof z.ZodError) throw new SetupError(422, 'ed_directory_fields_invalid')
          if (error instanceof EnterpriseDataError) throw new SetupError(422, error.code)
          if (error instanceof IntegrationInputError) throw new SetupError(503, error.message)
          throw error
        }
      })
      tail = task.catch(() => undefined)
      return task
    },
  }
}
