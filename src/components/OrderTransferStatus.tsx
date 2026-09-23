import { orderExportLabel } from '@/lib/status-labels'

export function OrderTransferStatus({ status, exportState }: { status: string; exportState: string | null }) {
  if (!exportState || ['DRAFT', 'CANCELLED', 'REJECTED', 'REVIEW_REQUIRED'].includes(status)) return null
  return <div className="order-transfer-status">
    <p>Передача в 1С: {orderExportLabel(exportState)}.</p>
    {exportState === 'FAILED' ? <p role="alert">Не удалось передать заявку в 1С. Заявка сохранена — обратитесь к менеджеру, создавать новую не нужно.</p>
      : ['DELIVERED', 'SUCCESS'].includes(exportState) && status === 'SUBMITTED' ? <p>Получение пакета ещё не подтверждает наличие, состав и сумму заказа.</p> : null}
  </div>
}
