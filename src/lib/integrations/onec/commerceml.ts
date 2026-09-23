import { SaxesParser } from 'saxes'

/**
 * Streaming CommerceML (1C "Обмен с сайтом") catalog parser.
 *
 * Memory-safe: SAX streaming, never a full DOM — the client's import file is
 * ~38 MB / 17.5k products on a 1.9 GB box. Products are emitted one at a time
 * via `onProduct`; only the (small) group tree is retained.
 *
 * Scope (v1): goods + category tree. Brand is deferred (folder depth is
 * inconsistent — no reliable structural rule), and prices/stock arrive in a
 * separate `offers` file. See docs/integrations + onec-integration memory.
 */

export type OnecGroup = { id: string; name: string; parentId: string | null }

/** Raw product payload shaped for `normalizeProductSnapshot` (externalId/sku/name/…). */
export type OnecRawProduct = {
  baseUnit?: { code: string; name: string }
  deleted?: boolean
  externalId: string
  sku: string
  name: string
  categoryExternalId?: string
  categoryName?: string
  barcode?: string
  packaging?: string
  groupId?: string
  code?: string
}

export type ParseResult = { groups: Map<string, OnecGroup>; productCount: number }

/** Walk group parents to the top-level ancestor (the storefront category, v1). */
export function topLevelCategoryId(groupId: string | undefined, groups: Map<string, OnecGroup>): string | undefined {
  let current = groupId
  const seen = new Set<string>()
  while (current && groups.has(current) && !seen.has(current)) {
    seen.add(current)
    const group = groups.get(current)!
    if (!group.parentId) return group.id
    current = group.parentId
  }
  return current && groups.has(current) ? current : groupId
}

type GroupFrame = { id: string | null; name: string | null; parentId: string | null }

/**
 * Parse a CommerceML catalog document. `onProduct` is called for each <Товар>
 * with the category already resolved to its top-level ancestor.
 */
export function parseCatalog(xml: string, onProduct: (product: OnecRawProduct) => void): ParseResult {
  const parser = new SaxesParser()
  const groups = new Map<string, OnecGroup>()
  const path: string[] = []
  let text = ''

  // Classifier group nesting.
  let inClassifier = false
  const groupStack: GroupFrame[] = []

  // Product accumulation.
  let inCatalog = false
  type ProductAcc = { baseUnit?: { code: string; name: string }; deleted?: boolean; externalId?: string; barcode?: string; article?: string; name?: string; unit?: string; groupId?: string; code?: string }
  let product: ProductAcc | null = null
  let reqName: string | null = null // current ЗначениеРеквизита/Наименование
  let reqValue: string | null = null // current ЗначениеРеквизита/Значение
  let productCount = 0

  const parent = () => path[path.length - 2]
  const grand = () => path[path.length - 3]

  parser.on('error', (error) => { throw error })

  parser.on('opentag', (node) => {
    path.push(node.name)
    text = ''
    if (node.name === 'Классификатор') inClassifier = true
    else if (node.name === 'Каталог') inCatalog = true
    else if (node.name === 'Группа' && inClassifier) {
      groupStack.push({ id: null, name: null, parentId: groupStack.length ? groupStack[groupStack.length - 1].id : null })
    } else if (node.name === 'Товар' && inCatalog) {
      product = { deleted: node.attributes['Статус'] === 'Удален' }
      reqName = null
      reqValue = null
    } else if (node.name === 'БазоваяЕдиница' && product) {
      const full = node.attributes['НаименованиеПолное']
      if (typeof full === 'string') product.unit = full.trim()
      const code = node.attributes['Код']
      if (typeof code === 'string' && typeof full === 'string') product.baseUnit = { code: code.trim(), name: full.trim() }
    } else if (node.name === 'ЗначениеРеквизита' && product) {
      reqName = null
      reqValue = null
    }
  })

  parser.on('text', (chunk) => { text += chunk })

  parser.on('closetag', (node) => {
    const value = text.trim()
    const p = parent()

    if (node.name === 'Группа' && inClassifier) {
      const frame = groupStack.pop()
      if (frame?.id) groups.set(frame.id, { id: frame.id, name: frame.name ?? '', parentId: frame.parentId })
    } else if (inClassifier && p === 'Группа' && groupStack.length) {
      const top = groupStack[groupStack.length - 1]
      if (node.name === 'Ид') top.id = value
      else if (node.name === 'Наименование') top.name = value
    } else if (product) {
      if (p === 'Товар') {
        if (node.name === 'Ид') product.externalId = value
        else if (node.name === 'Штрихкод') product.barcode = value
        else if (node.name === 'Артикул') product.article = value
        else if (node.name === 'Наименование') product.name = value
        else if (node.name === 'Статус') product.deleted = value === 'Удален'
        else if (node.name === 'ПометкаУдаления') product.deleted = value === 'true' || value === '1'
      } else if (node.name === 'Ид' && p === 'Группы' && grand() === 'Товар') {
        product.groupId = value
      } else if (p === 'ЗначениеРеквизита') {
        if (node.name === 'Наименование') reqName = value
        else if (node.name === 'Значение') reqValue = value
      } else if (node.name === 'ЗначениеРеквизита') {
        if (reqName === 'Код' && reqValue) product.code = reqValue
        reqName = null
        reqValue = null
      } else if (node.name === 'Товар') {
        emit(product)
        product = null
      }
    }

    if (node.name === 'Классификатор') inClassifier = false
    else if (node.name === 'Каталог') inCatalog = false
    path.pop()
    text = ''
  })

  function emit(acc: ProductAcc): void {
    const externalId = (acc.externalId ?? '').trim()
    const name = (acc.name ?? '').trim()
    // SKU key = Артикул, then Штрихкод, then internal Код (Артикул is often empty).
    const sku = (acc.article || acc.barcode || acc.code || '').trim()
    if (!externalId || (!acc.deleted && (!name || !sku))) throw new Error('invalid_catalog_product')
    productCount += 1
    const categoryExternalId = topLevelCategoryId(acc.groupId, groups)
    onProduct({
      externalId,
      ...(acc.deleted ? { deleted: true } : {}),
      sku,
      name,
      categoryExternalId,
      categoryName: categoryExternalId ? groups.get(categoryExternalId)?.name : undefined,
      barcode: acc.barcode || undefined,
      packaging: acc.unit || undefined,
      ...(acc.baseUnit ? { baseUnit: acc.baseUnit } : {}),
      groupId: acc.groupId || undefined,
      code: acc.code || undefined,
    })
  }

  parser.write(xml.replace(/^﻿/, '')).close()
  return { groups, productCount }
}

export type OnecOfferWarehouse = { id: string; qty: number }
export type OnecPrice = { priceTypeId: string; amount: number; currency: string }
export type OnecOffer = {
  externalId: string
  deleted?: boolean
  prices: OnecPrice[]
  qty?: number
  warehouses: OnecOfferWarehouse[]
}

function decimal(value: string, signed = false): number {
  const text = value.trim().replace(',', '.')
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) throw new Error('invalid_offer_number')
  const number = Number(text)
  if (!Number.isFinite(number) || (!signed && number < 0)) throw new Error('invalid_offer_number')
  return number
}

/** Preserve complete price tuples; XML order never selects a price book. */
export function parseOffers(xml: string, onOffer: (offer: OnecOffer) => void): { offerCount: number } {
  const parser = new SaxesParser(), path: string[] = []
  let text = '', offer: OnecOffer | null = null, price: Partial<OnecPrice> | null = null, offerCount = 0
  parser.on('error', error => { throw error })
  parser.on('doctype', () => { throw new Error('doctype_not_allowed') })
  parser.on('opentag', node => {
    path.push(node.name); text = ''
    if (node.name === 'Предложение') offer = { externalId: '', prices: [], warehouses: [], ...(node.attributes['Статус'] === 'Удален' ? { deleted: true } : {}) }
    else if (node.name === 'Цена' && offer) price = {}
    else if ((node.name === 'Склады' || node.name === 'Склад') && offer && typeof node.attributes['ИдСклада'] === 'string') {
      offer.warehouses.push({ id: node.attributes['ИдСклада'], qty: decimal(String(node.attributes['КоличествоНаСкладе'] ?? ''), true) })
    }
  })
  parser.on('text', chunk => { text += chunk })
  parser.on('closetag', node => {
    const value = text.trim(), parent = path[path.length - 2]
    if (offer) {
      if (parent === 'Предложение') {
        if (node.name === 'Ид') offer.externalId = value
        if (node.name === 'Количество') offer.qty = decimal(value, true)
        if (node.name === 'Статус') offer.deleted = value === 'Удален'
        if (node.name === 'ПометкаУдаления') offer.deleted = value === 'true' || value === '1'
      }
      if (price && parent === 'Цена') {
        if (node.name === 'ЦенаЗаЕдиницу') price.amount = decimal(value)
        if (node.name === 'Валюта') price.currency = value
        if (node.name === 'ИдТипаЦены') price.priceTypeId = value
      }
      if (node.name === 'Цена' && price) {
        // Missing identity/currency is preserved as invalid input for the importer.
        offer.prices.push({ priceTypeId: price.priceTypeId ?? '', currency: price.currency ?? '', amount: price.amount ?? NaN }); price = null
      }
      if (node.name === 'Предложение') {
        if (!offer.externalId) throw new Error('invalid_offer_identity')
        offerCount++; onOffer(offer); offer = null
      }
    }
    path.pop(); text = ''
  })
  parser.write(xml.replace(/^\uFEFF/, '')).close()
  return { offerCount }
}
