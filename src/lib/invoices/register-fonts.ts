import path from 'node:path'
import { Font } from '@react-pdf/renderer'

let registered = false

export const PDF_FONT = 'Roboto'

/** Register a Cyrillic-capable font — the built-in PDF fonts can't render RU. */
export function registerPdfFonts(): void {
  if (registered) return
  const fontsDir = path.join(process.cwd(), 'public', 'fonts')
  Font.register({
    family: PDF_FONT,
    fonts: [
      { src: path.join(fontsDir, 'Roboto-Regular.ttf'), fontWeight: 'normal' },
      { src: path.join(fontsDir, 'Roboto-Bold.ttf'), fontWeight: 'bold' },
    ],
  })
  registered = true
}
