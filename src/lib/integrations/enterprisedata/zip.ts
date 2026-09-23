import { inflateRawSync } from 'node:zlib'
import { MAX_XML_BYTES } from './message'
import { SetupError } from './http-setup'
export const MAX_ZIP_BYTES = 16 * 1024 * 1024
const bad = (): never => { throw new SetupError(422, 'ed_zip_invalid_or_unsupported') }
export function crc32(data: Buffer) {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    const value = data[i]
    crc ^= value
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}
/** Single-entry ZIP only; never extracts filesystem paths. Native inflater has an output limit. */
export function readXmlZip(zip: Buffer): Buffer {
  if (zip.length < 22 || zip.length > MAX_ZIP_BYTES) bad()
  try {
    let end = -1
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) {
      if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break }
    }
    if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6) || zip.readUInt16LE(end + 8) !== 1 || zip.readUInt16LE(end + 10) !== 1) bad()
    const central = zip.readUInt32LE(end + 16), centralSize = zip.readUInt32LE(end + 12)
    if (central + centralSize !== end || zip.readUInt32LE(central) !== 0x02014b50) bad()
    const flags = zip.readUInt16LE(central + 8), method = zip.readUInt16LE(central + 10)
    const crc = zip.readUInt32LE(central + 16), compressed = zip.readUInt32LE(central + 20), size = zip.readUInt32LE(central + 24)
    const nameLength = zip.readUInt16LE(central + 28), extraLength = zip.readUInt16LE(central + 30), commentLength = zip.readUInt16LE(central + 32)
    const mode = (zip.readUInt32LE(central + 38) >>> 16) & 0xf000
    if (flags & ~0x080e || ![0, 8].includes(method) || zip.readUInt16LE(central + 6) > 20 || !size || size > MAX_XML_BYTES
      || !compressed || compressed > MAX_ZIP_BYTES || zip.readUInt16LE(central + 34) || zip.readUInt32LE(central + 42) !== 0
      || mode && mode !== 0x8000 || 46 + nameLength + extraLength + commentLength !== centralSize) bad()
    const name = zip.subarray(central + 46, central + 46 + nameLength)
    const label = name.toString('latin1')
    if (!nameLength || nameLength > 255 || /[\\/:\x00]/.test(label) || label === '.' || label === '..') bad()
    if (zip.readUInt32LE(0) !== 0x04034b50 || zip.readUInt16LE(4) > 20 || zip.readUInt16LE(6) !== flags || zip.readUInt16LE(8) !== method) bad()
    const localName = zip.readUInt16LE(26), localExtra = zip.readUInt16LE(28), dataStart = 30 + localName + localExtra
    if (!name.equals(zip.subarray(30, 30 + localName)) || dataStart + compressed > central) bad()
    if (flags & 8) {
      let descriptor = dataStart + compressed
      if (zip.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4
      if (descriptor + 12 !== central || zip.readUInt32LE(descriptor) !== crc || zip.readUInt32LE(descriptor + 4) !== compressed || zip.readUInt32LE(descriptor + 8) !== size) bad()
    } else if (dataStart + compressed !== central || zip.readUInt32LE(14) !== crc || zip.readUInt32LE(18) !== compressed || zip.readUInt32LE(22) !== size) bad()
    const payload = zip.subarray(dataStart, dataStart + compressed)
    const xml = method === 0 ? Buffer.from(payload) : inflateRawSync(payload, { maxOutputLength: MAX_XML_BYTES })
    if (xml.length !== size || crc32(xml) !== crc) bad()
    return xml
  } catch (e) { if (e instanceof SetupError) throw e; return bad() }
}
/** Deterministic stored ZIP. Compression is optional in ZIP and 1C's reader supports it. */
export function writeXmlZip(xml: Buffer) {
  if (!xml.length || xml.length > MAX_XML_BYTES - 256) bad()
  const name = Buffer.from('Message.xml'), crc = crc32(xml)
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
  local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(xml.length, 18); local.writeUInt32LE(xml.length, 22); local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16); central.writeUInt32LE(xml.length, 20); central.writeUInt32LE(xml.length, 24); central.writeUInt16LE(name.length, 28)
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length + name.length, 12); end.writeUInt32LE(local.length + name.length + xml.length, 16)
  return Buffer.concat([local, name, xml, central, name, end])
}
