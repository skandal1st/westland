import { prisma } from '../src/lib/db'
import { getActiveStore } from '../src/lib/store'
import { runWorkerTick } from '../src/lib/integrations/worker'

async function main() {
  const once = process.argv.includes('--once')
  const interval = Number(process.env.INTEGRATION_WORKER_INTERVAL_MS ?? 5_000)
  if (!Number.isInteger(interval) || interval < 250 || interval > 60_000) throw new Error('invalid_worker_interval')
  let stopping = false, wake: (() => void) | undefined, exportsFirst = false
  const stop = () => { stopping = true; wake?.() }
  process.on('SIGTERM', stop); process.on('SIGINT', stop)
  try {
    const store = await getActiveStore()
    if (process.argv.includes('--health')) {
      const row = await prisma.integrationWorker.findUnique({ where: { storeId: store.id } })
      const fresh = row && !row.lastError && ((row.leaseExpiresAt?.getTime() ?? 0) > Date.now() || (row.lastFinishedAt?.getTime() ?? 0) > Date.now() - Math.max(30_000, interval * 3))
      if (!fresh) process.exitCode = 1
      return
    }
    do {
      try {
        const result = await runWorkerTick({ storeId: store.id, exportsFirst, shouldStop: () => stopping })
        if (once || result.processed) console.log(JSON.stringify({ event: 'integration_worker_tick', ...result }))
      } catch (error) {
        console.error(JSON.stringify({ event: 'integration_worker_error', message: error instanceof Error ? error.message : String(error) }))
        if (once) { process.exitCode = 1; break }
      }
      exportsFirst = !exportsFirst
      if (once || stopping) break
      await new Promise<void>(resolve => {
        const timer = setTimeout(resolve, interval)
        wake = () => { clearTimeout(timer); resolve() }
      })
      wake = undefined
    } while (!stopping)
  } finally {
    process.off('SIGTERM', stop); process.off('SIGINT', stop)
    await prisma.$disconnect()
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
