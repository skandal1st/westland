import { SaxesParser } from 'saxes'
import type { ImportMode } from '@/lib/integrations/provider'
import { IntegrationInputError } from '@/lib/integrations/errors'

export type ExchangeMetadata = { mode: ImportMode; sourceUpdatedAt: string | null; priceTypes: string[]; warehouses: string[]; identity: string | null }
/** Only explicit full authorizes absence cleanup. A timestamp without timezone is unknown. */
export function parseExchangeMetadata(xml: string, kind: 'catalog' | 'offers'): ExchangeMetadata {
  const result: ExchangeMetadata = { mode: 'unknown', sourceUpdatedAt: null, priceTypes: [], warehouses: [], identity: null }
  const parser = new SaxesParser(), path: string[] = []
  let text = '', packets = 0
  parser.on('error', error => { throw error })
  parser.on('doctype', () => { throw new IntegrationInputError('doctype_not_allowed') })
  parser.on('opentag', node => {
    path.push(node.name); text = ''
    if (node.name === 'КоммерческаяИнформация') {
      const at = node.attributes['ДатаФормирования']
      if (typeof at === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(at) && Number.isFinite(Date.parse(at))) result.sourceUpdatedAt = new Date(at).toISOString()
    }
    if ((kind === 'catalog' && node.name === 'Каталог') || (kind === 'offers' && ['ПакетПредложений', 'ИзмененияПакетаПредложений'].includes(node.name))) {
      if (++packets > 1) throw new IntegrationInputError('multiple_exchange_packets')
      const flag = node.attributes['СодержитТолькоИзменения']
      if (flag !== undefined && !['true', 'false', '0', '1'].includes(String(flag))) throw new IntegrationInputError('invalid_exchange_mode')
      result.mode = node.name === 'ИзмененияПакетаПредложений' || flag === 'true' || flag === '1' ? 'delta' : flag === 'false' || flag === '0' ? 'full' : 'unknown'
    }
  })
  parser.on('text', chunk => { text += chunk })
  parser.on('closetag', node => {
    const parent = path[path.length - 2], grand = path[path.length - 3], value = text.trim()
    if (node.name === 'Ид' && value) {
      if (parent === 'ТипЦены' && grand === 'ТипыЦен') result.priceTypes.push(value)
      if (parent === 'Склад' && grand === 'Склады') result.warehouses.push(value)
      if (parent === (kind === 'catalog' ? 'Каталог' : 'ПакетПредложений') || parent === 'ИзмененияПакетаПредложений') result.identity = value
    }
    path.pop(); text = ''
  })
  parser.write(xml.replace(/^\uFEFF/, '')).close()
  if (packets !== 1) throw new IntegrationInputError('exchange_packet_missing')
  result.priceTypes = Array.from(new Set(result.priceTypes)).sort()
  result.warehouses = Array.from(new Set(result.warehouses)).sort()
  return result
}

export function mergeMetadata(rows: ExchangeMetadata[]): ExchangeMetadata {
  if (!rows.length) return { mode: 'unknown', sourceUpdatedAt: null, priceTypes: [], warehouses: [], identity: null }
  const first = rows[0]
  if (rows.some(r => r.mode !== first.mode || r.identity !== first.identity || r.sourceUpdatedAt !== first.sourceUpdatedAt)) throw new IntegrationInputError('inconsistent_exchange_parts')
  return { ...first, priceTypes: Array.from(new Set(rows.flatMap(r => r.priceTypes))).sort(), warehouses: Array.from(new Set(rows.flatMap(r => r.warehouses))).sort() }
}
