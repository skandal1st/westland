type FooterRequisites = {
  companyName?: string
  inn?: string
  ogrn?: string
}

export function SiteFooter({ storeName, requisites }: { storeName: string; requisites: FooterRequisites }) {
  const companyName = requisites.companyName?.trim() || storeName
  const inn = requisites.inn?.trim()
  const ogrn = requisites.ogrn?.trim()

  return <footer className="site-footer">
    <div className="site-footer-inner">
      <div className="site-footer-company">
        <strong>{companyName}</strong>
        {inn || ogrn ? <span>{inn ? `ИНН ${inn}` : null}{inn && ogrn ? ' · ' : null}{ogrn ? `ОГРН ${ogrn}` : null}</span> : null}
      </div>
      <p>Создано в <a href="https://aximatech.ru" target="_blank" rel="noreferrer">AXIMA</a></p>
    </div>
  </footer>
}
