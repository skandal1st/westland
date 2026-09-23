import { createHash } from 'node:crypto'
import { SaxesParser } from 'saxes'

export const MESSAGE_NS = 'http://www.1c.ru/SSL/Exchange/Message'
export const FORMAT_BASE = 'http://v8.1c.ru/edi/edi_stnd/EnterpriseData'
export const ED_VERSION = '1.20'
export const ED_NS = FORMAT_BASE + '/' + ED_VERSION
export const MAX_XML_BYTES = 16 * 1024 * 1024
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export class EnterpriseDataError extends Error {
  constructor(public code: string) { super(code); this.name = 'EnterpriseDataError' }
}
export const fail = (code: string): never => { throw new EnterpriseDataError(code) }
export function xmlText(value: string) {
  for (const char of Array.from(value)) {
    const n = char.codePointAt(0)!
    if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0xD7FF || n >= 0xE000 && n <= 0xFFFD || n >= 0x10000 && n <= 0x10FFFF)) fail('ed_invalid_xml_character')
  }
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
export const element = (name: string, value: string) => '<' + name + '>' + xmlText(value) + '</' + name + '>'
export type XmlNode = { name: string; ns: string; text: string; children: XmlNode[]; attributes?: Record<string, string> }
export function child(node: XmlNode, name: string, ns = node.ns): XmlNode | undefined {
  const found = node.children.filter(n => n.name === name && n.ns === ns)
  if (found.length > 1) fail('ed_duplicate_element')
  return found[0]
}
export function scalar(node: XmlNode, name: string, ns = node.ns): string {
  const n = child(node, name, ns)
  if (!n || n.children.length) return fail('ed_missing_scalar_' + name)
  return n.text.trim()
}
function counter(value: string) {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) return fail('ed_invalid_message_number')
  return Number(value)
}
export function parseXml(bytes: Buffer): XmlNode {
  if (!bytes.length || bytes.length > MAX_XML_BYTES) fail('ed_xml_size')
  let xml: string
  try { xml = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return fail('ed_utf8_required') }
  const parser = new SaxesParser({ xmlns: true }); const stack: XmlNode[] = []; let root: XmlNode | undefined; let count = 0
  parser.on('error', () => fail('ed_malformed_xml'))
  parser.on('doctype', () => fail('ed_doctype_forbidden'))
  parser.on('xmldecl', d => { if (d.encoding && !/^utf-?8$/i.test(d.encoding)) fail('ed_utf8_required') })
  parser.on('opentag', tag => {
    if (++count > 200_000 || stack.length >= 48) fail('ed_xml_complexity')
    const n: XmlNode = { name: tag.local, ns: tag.uri, text: '', children: [] }
    const attributes = Object.values(tag.attributes).filter(a => a.uri !== 'http://www.w3.org/2000/xmlns/')
    if (attributes.length) n.attributes = Object.fromEntries(attributes.map(a => [a.uri + '|' + a.local, a.value]))
    if (stack.length) stack[stack.length - 1].children.push(n); else root = n
    stack.push(n)
  })
  const text = (s: string) => { if (stack.length) stack[stack.length - 1].text += s }
  parser.on('text', text); parser.on('cdata', text); parser.on('closetag', () => { stack.pop() })
  parser.write(xml).close()
  return root ?? fail('ed_empty_xml')
}
export type Confirmation = { plan: string; from: string; to: string; messageNo: number; receivedNo: number }
export function inspectMessage(bytes: Buffer) {
  const root = parseXml(bytes)
  if (root.name !== 'Message' || !['', MESSAGE_NS].includes(root.ns)) fail('ed_message_required')
  const header = child(root, 'Header', MESSAGE_NS) ?? fail('ed_header_required')
  const creationDate = scalar(header, 'CreationDate')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/.test(creationDate) || !Number.isFinite(Date.parse(creationDate))) fail('ed_invalid_date')
  const format = scalar(header, 'Format')
  if (format !== FORMAT_BASE && !/^http:\/\/v8\.1c\.ru\/edi\/edi_stnd\/EnterpriseData\/\d+\.\d+$/.test(format)) fail('ed_format_namespace')
  const confirmation = child(header, 'Confirmation') ?? fail('ed_confirmation_required')
  const c: Confirmation = { plan: scalar(confirmation, 'ExchangePlan'), from: scalar(confirmation, 'From'), to: scalar(confirmation, 'To'),
    messageNo: counter(scalar(confirmation, 'MessageNo')), receivedNo: counter(scalar(confirmation, 'ReceivedNo')) }
  if (!c.plan || !c.from || !c.to || c.from === c.to) fail('ed_invalid_nodes')
  const versions = header.children.filter(n => n.name === 'AvailableVersion' && n.ns === MESSAGE_NS).map(n => {
    if (n.children.length || !/^\d+\.\d+$/.test(n.text.trim())) fail('ed_invalid_version')
    return n.text.trim()
  })
  if (!versions.length || versions.length > 100 || new Set(versions).size !== versions.length) fail('ed_invalid_versions')
  const bodies = root.children.filter(n => n.name === 'Body')
  if (bodies.length > 1) fail('ed_duplicate_body')
  const body = bodies[0]
  if (body && (format === FORMAT_BASE || body.ns !== format)) fail('ed_body_namespace')
  if (root.text.trim() || header.text.trim() || confirmation.text.trim() || body?.text.trim() || body?.children.some(n => n.ns !== format)) fail('ed_invalid_envelope_content')
  if (root.children.some(n => n !== header && n !== body)) fail('ed_unknown_envelope_element')
  const declarations = child(header, 'AvailableObjectTypes')?.children ?? []
  const objectTypes = declarations.map(n => {
    if (n.name !== 'ObjectType' || n.ns !== MESSAGE_NS) fail('ed_invalid_capabilities')
    return { name: scalar(n, 'Name'), sending: scalar(n, 'Sending'), receiving: scalar(n, 'Receiving') }
  })
  if (new Set(objectTypes.map(t => t.name)).size !== objectTypes.length) fail('ed_duplicate_capabilities')
  return { sha256: digest(bytes), format, confirmation: c, versions, objectTypes, hasObjectTypes: !!child(header, 'AvailableObjectTypes'), objects: body?.children ?? [], hasBody: !!body }
}
export type ObjectCapability = { name: string; sending: string; receiving: string }
export function envelope(c: Confirmation, objects: string[], createdAt: string, settings = false, capabilities?: ObjectCapability[]) {
  if (!Number.isSafeInteger(c.messageNo) || c.messageNo < 0 || !Number.isSafeInteger(c.receivedNo) || c.receivedNo < 0) fail('ed_invalid_message_number')
  if (settings && (objects.length || c.messageNo || c.receivedNo)) fail('ed_invalid_settings')
  if (!Number.isFinite(Date.parse(createdAt))) fail('ed_invalid_date')
  const msg = (name: string, value: string) => element('msg:' + name, value)
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n<Message xmlns:msg="' + MESSAGE_NS + '"><msg:Header>'
    + msg('Format', settings ? FORMAT_BASE : ED_NS) + msg('CreationDate', createdAt)
    + '<msg:Confirmation>' + msg('ExchangePlan', c.plan) + msg('To', c.to) + msg('From', c.from)
    + msg('MessageNo', String(c.messageNo)) + msg('ReceivedNo', String(c.receivedNo)) + '</msg:Confirmation>'
    + msg('AvailableVersion', ED_VERSION)
    + (capabilities === undefined ? '' : '<msg:AvailableObjectTypes>' + capabilities.map(o => '<msg:ObjectType>' + msg('Name', o.name) + msg('Sending', o.sending) + msg('Receiving', o.receiving) + '</msg:ObjectType>').join('') + '</msg:AvailableObjectTypes>') + '</msg:Header>'
    + (settings ? '' : '<Body xmlns="' + ED_NS + '">' + objects.join('') + '</Body>') + '</Message>'
  inspectMessage(Buffer.from(xml))
  return xml
}
