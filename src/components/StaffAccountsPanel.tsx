'use client'

import { ShieldCheck, UserRoundCog } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { readArray, useRemoteResource } from '@/lib/use-remote-resource'

type StaffAccount = {
  id: string
  email: string
  name: string
  role: 'STAFF' | 'ADMIN'
  status: 'ACTIVE' | 'SUSPENDED'
  createdAt: string
}

const decodeAccounts = (value: unknown) => readArray<StaffAccount>(value, 'users')

export function StaffAccountsPanel() {
  const resource = useRemoteResource('/api/staff/team', decodeAccounts)
  const [role, setRole] = useState<'STAFF' | 'ADMIN'>('STAFF')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    setBusy(true)
    setMessage(null)
    try {
      const response = await fetch('/api/staff/team', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: String(fields.get('name') ?? ''),
          email: String(fields.get('email') ?? ''),
          password: String(fields.get('password') ?? ''),
          role,
        }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) {
        const text = result.error === 'EMAIL_EXISTS'
          ? 'Пользователь с такой почтой уже существует.'
          : result.error === 'INVALID_INPUT'
            ? 'Проверьте имя, почту и пароль: пароль должен содержать не менее 12 символов и занимать не более 72 байт.'
            : result.error === 'FORBIDDEN'
              ? 'Создавать сотрудников может только действующий администратор.'
              : 'Не удалось создать сотрудника. Обновите страницу и повторите.'
        setMessage({ kind: 'error', text })
        return
      }
      form.reset()
      setRole('STAFF')
      setMessage({ kind: 'success', text: 'Аккаунт создан. Передайте сотруднику почту и временный пароль безопасным способом.' })
      await resource.reload()
    } catch {
      setMessage({ kind: 'error', text: 'Не удалось связаться с сервером. Проверьте подключение и повторите.' })
    } finally {
      setBusy(false)
    }
  }

  const users = resource.data ?? []

  return <div className="staff-accounts-panel">
    <section className="staff-account-create">
      <div className="staff-account-heading">
        <div><h2>Новый сотрудник</h2><p>Создайте отдельный аккаунт для работы в панели управления.</p></div>
        <UserRoundCog />
      </div>
      <form onSubmit={submit}>
        <div className="staff-account-fields">
          <label>Имя<input name="name" required maxLength={200} autoComplete="name" placeholder="Имя сотрудника" /></label>
          <label>Электронная почта<input name="email" required type="email" maxLength={254} autoComplete="email" placeholder="name@company.ru" /></label>
          <label>Роль<select name="role" value={role} onChange={event => setRole(event.target.value as 'STAFF' | 'ADMIN')}><option value="STAFF">Сотрудник</option><option value="ADMIN">Администратор</option></select></label>
          <label>Временный пароль<input name="password" required type="password" minLength={12} maxLength={72} autoComplete="new-password" placeholder="Не менее 12 символов" /></label>
        </div>
        {role === 'ADMIN' ? <p className="staff-account-warning"><ShieldCheck /> Администратор получит полный доступ, включая создание других сотрудников и администраторов.</p> : null}
        <p className="staff-account-hint">Пароль не показывается повторно и не попадает в журнал действий.</p>
        <button className="button button-primary" type="submit" disabled={busy}>{busy ? 'Создание…' : 'Создать аккаунт'}</button>
      </form>
      {message ? <p className={message.kind === 'error' ? 'auth-error' : 'staff-account-success'} role={message.kind === 'error' ? 'alert' : 'status'}>{message.text}</p> : null}
    </section>

    <section>
      <div className="staff-account-heading"><div><h2>Команда</h2><p>Активные и приостановленные аккаунты сотрудников этого магазина.</p></div><strong>{users.length}</strong></div>
      {resource.loading && !resource.data ? <p role="status">Загрузка сотрудников…</p> : null}
      {resource.error ? <div className="load-error" role="alert"><span>{resource.error}</span><button type="button" onClick={resource.reload}>Повторить</button></div> : null}
      {!resource.loading && !resource.error && users.length === 0 ? <p className="commerce-empty">Сотрудники ещё не созданы.</p> : null}
      {users.length ? <div className="staff-account-list">
        <div className="staff-account-list-head"><span>Сотрудник</span><span>Роль</span><span>Статус</span><span>Создан</span></div>
        {users.map(user => <div className="staff-account-row" key={user.id}>
          <span><strong>{user.name}</strong><small>{user.email}</small></span>
          <span data-label="Роль">{user.role === 'ADMIN' ? 'Администратор' : 'Сотрудник'}</span>
          <b className={user.status === 'ACTIVE' ? 'active' : ''} data-label="Статус">{user.status === 'ACTIVE' ? 'Активен' : 'Приостановлен'}</b>
          <time data-label="Создан" dateTime={user.createdAt}>{new Date(user.createdAt).toLocaleDateString('ru-RU')}</time>
        </div>)}
      </div> : null}
    </section>
  </div>
}
