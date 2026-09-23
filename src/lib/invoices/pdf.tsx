import { formatMoney as fmtMoney } from '@/lib/money-format'
import { Document, Page, Text, View, StyleSheet, renderToBuffer } from '@react-pdf/renderer'
import type { InvoiceWithLines } from '@/lib/invoices/invoices'
import { buyerOf, sellerOf } from '@/lib/invoices/invoices'
import { PDF_FONT, registerPdfFonts } from '@/lib/invoices/register-fonts'

const styles = StyleSheet.create({
  page: { padding: 40, fontSize: 9, fontFamily: PDF_FONT },
  title: { fontSize: 14, fontWeight: 'bold', marginBottom: 16, textAlign: 'center' },
  parties: { flexDirection: 'row', gap: 24, marginBottom: 16 },
  partyCol: { flex: 1 },
  partyTitle: { fontSize: 8, fontWeight: 'bold', marginBottom: 4, color: '#555' },
  partyText: { fontSize: 9, marginBottom: 2 },
  bankBlock: { borderWidth: 1, borderColor: '#ddd', marginBottom: 16 },
  bankRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#ddd' },
  bankRowLast: { flexDirection: 'row' },
  bankLabel: { width: 120, padding: 5, borderRightWidth: 1, borderRightColor: '#ddd', fontSize: 8, color: '#666' },
  bankValue: { flex: 1, padding: 5, fontSize: 9 },
  table: { borderWidth: 1, borderColor: '#ddd', marginBottom: 12 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#f5f5f5', borderBottomWidth: 1, borderBottomColor: '#ddd' },
  tableRow: { flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: '#eee' },
  cellNum: { width: 24, padding: 5, textAlign: 'center', borderRightWidth: 1, borderRightColor: '#eee' },
  cellName: { flex: 3, padding: 5, borderRightWidth: 1, borderRightColor: '#eee' },
  cellQty: { width: 44, padding: 5, textAlign: 'center', borderRightWidth: 1, borderRightColor: '#eee' },
  cellPrice: { width: 94, fontSize: 7, padding: 5, textAlign: 'right', borderRightWidth: 1, borderRightColor: '#eee' },
  cellSum: { width: 102, fontSize: 7, padding: 5, textAlign: 'right' },
  headerText: { fontSize: 7, fontWeight: 'bold', color: '#555' },
  totals: { alignItems: 'flex-end', marginBottom: 20 },
  totalLine: { flexDirection: 'row', gap: 12, marginBottom: 3 },
  totalLabel: { fontSize: 9, color: '#555' },
  totalValue: { fontSize: 9, fontWeight: 'bold', width: 180, textAlign: 'right' },
  totalMain: { fontSize: 11, fontWeight: 'bold' },
  signature: { marginTop: 24 },
  sigLine: { flexDirection: 'row', gap: 8, marginBottom: 16 },
  footer: { marginTop: 16, fontSize: 8, color: '#aaa', textAlign: 'center' },
})



function InvoiceDoc({ invoice }: { invoice: InvoiceWithLines }) {
  const seller = sellerOf(invoice)
  const buyer = buyerOf(invoice)
  const dateStr = invoice.issuedAt.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' })
  const total = invoice.total.toFixed(2)
  const vatRate = invoice.vatRate == null ? null : Number(invoice.vatRate)
  const vatAmount = invoice.vatAmount.toFixed(2)
  const bank = invoice.paymentMethod === 'CASH' ? undefined : seller?.bank

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>Счёт на оплату № {invoice.number} от {dateStr}</Text>

        {invoice.paymentMethod ? <Text style={{ marginBottom: 12 }}>Способ оплаты: {invoice.paymentMethod === 'CASH' ? 'Наличный расчёт' : 'Безналичный расчёт'}</Text> : null}

        <View style={styles.parties}>
          <View style={styles.partyCol}>
            <Text style={styles.partyTitle}>Поставщик (Исполнитель):</Text>
            <Text style={styles.partyText}>{seller?.companyName || '—'}</Text>
            {seller?.inn ? (
              <Text style={styles.partyText}>ИНН {seller.inn}{seller.kpp ? `, КПП ${seller.kpp}` : ''}</Text>
            ) : null}
            {seller?.legalAddress ? <Text style={styles.partyText}>{seller.legalAddress}</Text> : null}
            {seller?.phone ? <Text style={styles.partyText}>тел. {seller.phone}</Text> : null}
          </View>
          <View style={styles.partyCol}>
            <Text style={styles.partyTitle}>Покупатель (Заказчик):</Text>
            <Text style={styles.partyText}>{buyer?.legalName || '—'}</Text>
            {buyer?.inn ? (
              <Text style={styles.partyText}>ИНН {buyer.inn}{buyer.kpp ? `, КПП ${buyer.kpp}` : ''}</Text>
            ) : null}
            {buyer ? <Text style={styles.partyText}>{buyer.deliveryName}, {buyer.deliveryCity}, {buyer.deliveryAddress}</Text> : null}
          </View>
        </View>

        {(bank?.name || bank?.account) && (
          <View style={styles.bankBlock}>
            <View style={styles.bankRow}><Text style={styles.bankLabel}>Банк получателя</Text><Text style={styles.bankValue}>{bank?.name || '—'}</Text></View>
            <View style={styles.bankRow}><Text style={styles.bankLabel}>БИК</Text><Text style={styles.bankValue}>{bank?.bik || '—'}</Text></View>
            <View style={styles.bankRow}><Text style={styles.bankLabel}>Сч. №</Text><Text style={styles.bankValue}>{bank?.account || '—'}</Text></View>
            <View style={styles.bankRowLast}><Text style={styles.bankLabel}>Корр. счёт</Text><Text style={styles.bankValue}>{bank?.corAccount || '—'}</Text></View>
          </View>
        )}

        <View style={styles.table}>
          <View style={styles.tableHeader}>
            <View style={styles.cellNum}><Text style={styles.headerText}>№</Text></View>
            <View style={styles.cellName}><Text style={styles.headerText}>Наименование товара, работ, услуг</Text></View>
            <View style={styles.cellQty}><Text style={styles.headerText}>Кол-во</Text></View>
            <View style={styles.cellPrice}><Text style={styles.headerText}>Цена</Text></View>
            <View style={styles.cellSum}><Text style={styles.headerText}>Сумма</Text></View>
          </View>
          {invoice.lines.map((line) => (
            <View key={line.id} style={styles.tableRow}>
              <View style={styles.cellNum}><Text>{line.position}</Text></View>
              <View style={styles.cellName}><Text>{line.name}{line.packaging ? `, ${line.packaging}` : ''}</Text></View>
              <View style={styles.cellQty}><Text>{line.quantity.toString()}</Text></View>
              <View style={styles.cellPrice}><Text>{fmtMoney(line.unitPrice.toFixed(2))}</Text></View>
              <View style={styles.cellSum}><Text>{fmtMoney(line.lineTotal.toFixed(2))}</Text></View>
            </View>
          ))}
        </View>

        <View style={styles.totals}>
          <View style={styles.totalLine}>
            <Text style={styles.totalLabel}>Итого:</Text>
            <Text style={styles.totalValue}>{fmtMoney(total)}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text style={styles.totalLabel}>{vatRate != null ? `В том числе НДС (${vatRate}%):` : 'В том числе НДС:'}</Text>
            <Text style={styles.totalValue}>{vatRate != null ? fmtMoney(vatAmount) : 'Без НДС'}</Text>
          </View>
          <View style={styles.totalLine}>
            <Text style={styles.totalMain}>Всего к оплате:</Text>
            <Text style={{ fontSize: 11, fontWeight: 'bold', width: 180, textAlign: 'right' }}>{fmtMoney(total)} {invoice.currency}</Text>
          </View>
        </View>

        {invoice.paymentMethod !== 'CASH' && seller?.paymentPurpose ? (
          <Text style={{ fontSize: 9, color: '#555', marginBottom: 12 }}>Назначение платежа: {seller.paymentPurpose}</Text>
        ) : null}

        <View style={styles.signature}>
          <View style={styles.sigLine}>
            <Text style={{ fontSize: 9 }}>Руководитель</Text>
            <Text style={{ flex: 1, borderBottomWidth: 1, borderBottomColor: '#333' }} />
            <Text style={{ fontSize: 9 }}>{seller?.directorName || ''}</Text>
          </View>
          <View style={styles.sigLine}>
            <Text style={{ fontSize: 9 }}>Бухгалтер</Text>
            <Text style={{ flex: 1, borderBottomWidth: 1, borderBottomColor: '#333' }} />
            <Text style={{ fontSize: 9 }}>{seller?.accountantName || ''}</Text>
          </View>
        </View>

        <Text style={styles.footer}>{seller?.companyName}{seller?.email ? ` · ${seller.email}` : ''}{seller?.phone ? ` · ${seller.phone}` : ''}</Text>
      </Page>
    </Document>
  )
}

// The layout engine has process-wide WASM state. Serialize renders, including
// the first initialization; a rejected render must not poison the next request.
let renderQueue: Promise<void> = Promise.resolve()

/** Render the issued invoice snapshot without reading mutable directories. */
export function renderInvoicePdf(invoice: InvoiceWithLines): Promise<Buffer> {
  const result = renderQueue.then(async () => {
    registerPdfFonts()
    return renderToBuffer(<InvoiceDoc invoice={invoice} />)
  })
  renderQueue = result.then(() => undefined, () => undefined)
  return result
}
