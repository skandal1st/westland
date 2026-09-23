import { DIRECTORY_TYPES } from './directory-parser'
import { ED_VERSION, type ObjectCapability } from './message'
/** XML directions describe this adapter. JSON directions describe the calling 1C.
 * Capture mode permits a manually reviewed order sample; directory mode advertises only implemented imports.
 * Explicit XML capabilities avoid BSP's missing-header fallback to supporting every object.
 */
export function pilotCapabilities(captureOrderSample = false, directoryEnabled = false): ObjectCapability[] {
  return [{ name: 'Документ.ЗаказКлиента', sending: ED_VERSION, receiving: captureOrderSample ? ED_VERSION : '' }, ...(directoryEnabled ? Object.keys(DIRECTORY_TYPES).map(name => ({ name, sending: '', receiving: ED_VERSION })) : [])]
}
export function pilotJsonCapabilities(captureOrderSample = false, directoryEnabled = false) {
  return pilotCapabilities(captureOrderSample, directoryEnabled).map(o => ({ Object: o.name, Send: o.receiving ? [o.receiving] : [], Receive: o.sending ? [o.sending] : [] }))
}
