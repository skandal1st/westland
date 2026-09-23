import type { IntegrationProvider } from '@prisma/client'
import { handleOnecExchange } from './onec/http'
/** HTTP transport dispatch stays in the adapter layer. */
export function handleInboundExchange(provider: IntegrationProvider, request: Request): Promise<Response> {
  if (provider === 'ONE_C') return handleOnecExchange(request)
  return Promise.resolve(new Response('failure\nprovider_not_configured', { status: 503 }))
}
