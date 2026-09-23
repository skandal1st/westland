import { handleInboundExchange } from '@/lib/integrations/inbound'
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
const handle = (request: Request) => handleInboundExchange('ONE_C', request)
export const GET = handle
export const POST = handle
