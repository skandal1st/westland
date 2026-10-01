'use client'
/* eslint-disable @next/next/no-img-element -- Product images are validated staff uploads served by the application. */

import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'

type GalleryProduct = { displayName: string; imageUrls: string[] }

export function ProductGallery({ product, onClose }: { product: GalleryProduct | null; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
    const dialog = dialogRef.current
    if (!dialog) return
    if (product && !dialog.open) dialog.showModal()
    if (!product && dialog.open) dialog.close()
  }, [product])

  useEffect(() => {
    if (!product) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); setIndex(current => (current - 1 + product.imageUrls.length) % product.imageUrls.length) }
      if (event.key === 'ArrowRight') { event.preventDefault(); setIndex(current => (current + 1) % product.imageUrls.length) }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [product])

  const images = product?.imageUrls ?? []
  const current = images[index]

  return <dialog
    className="product-gallery"
    ref={dialogRef}
    aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); onClose() }}
    onClose={onClose}
    onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}
  >
    {product && current ? <>
      <header><div><h2 id={titleId}>{product.displayName}</h2><span>{index + 1} из {images.length}</span></div><button type="button" className="icon-button" aria-label="Закрыть галерею" onClick={onClose}><X /></button></header>
      <div className="product-gallery-stage">
        <img src={current} alt={`${product.displayName}, изображение ${index + 1}`} />
        {images.length > 1 ? <><button type="button" className="product-gallery-prev" aria-label="Предыдущее изображение" onClick={() => setIndex(value => (value - 1 + images.length) % images.length)}><ChevronLeft /></button><button type="button" className="product-gallery-next" aria-label="Следующее изображение" onClick={() => setIndex(value => (value + 1) % images.length)}><ChevronRight /></button></> : null}
      </div>
      {images.length > 1 ? <div className="product-gallery-thumbs" aria-label="Изображения товара">{images.map((url, imageIndex) => <button type="button" key={url} aria-label={`Открыть изображение ${imageIndex + 1}`} aria-pressed={imageIndex === index} onClick={() => setIndex(imageIndex)}><img src={url} alt="" /></button>)}</div> : null}
    </> : null}
  </dialog>
}
