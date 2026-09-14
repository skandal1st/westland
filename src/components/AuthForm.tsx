'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { signIn } from 'next-auth/react'
import { useState } from 'react'

const REGISTER_ERRORS: Record<string, string> = {
  EMAIL_TAKEN: 'Пользователь с такой почтой уже существует.',
  ALREADY_PENDING: 'Заявка с этой почтой уже на рассмотрении.',
  INVALID_INN: 'ИНН должен содержать 10 или 12 цифр.',
  invalid_input: 'Проверьте правильность заполнения полей.',
  rate_limited: 'Слишком много попыток. Повторите позже.',
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter()
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  if (sent) {
    return (
      <div className="auth-success">
        <h1>Заявка принята</h1>
        <p>После проверки реквизитов сотрудник откроет доступ и назначит ценовую группу.</p>
        <Link className="button button-primary" href="/">На главную</Link>
      </div>
    )
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      if (mode === 'login') {
        const result = await signIn('credentials', {
          redirect: false,
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
        })
        if (result?.error) {
          setError('Неверная почта или пароль, либо доступ приостановлен.')
        } else {
          router.push('/catalog')
          router.refresh()
        }
      } else {
        const payload = {
          email: String(form.get('email') ?? ''),
          password: String(form.get('password') ?? ''),
          legalName: String(form.get('legalName') ?? ''),
          inn: String(form.get('inn') ?? ''),
          kpp: String(form.get('kpp') ?? '') || undefined,
          contactName: String(form.get('contactName') ?? ''),
          phone: String(form.get('phone') ?? '') || undefined,
        }
        const response = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
        if (response.ok) {
          setSent(true)
        } else {
          const data = await response.json().catch(() => ({}))
          setError(REGISTER_ERRORS[data.error] ?? 'Не удалось отправить заявку. Попробуйте позже.')
        }
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="auth-card" onSubmit={onSubmit}>
      <h1>{mode === 'login' ? 'Вход для партнёров' : 'Регистрация компании'}</h1>
      <p>{mode === 'login' ? 'Каталог, цены и остатки доступны после авторизации.' : 'Укажите данные юридического лица. Политика подтверждения настраивается в бек-офисе.'}</p>
      {mode === 'register' ? (
        <>
          <label>Название компании<input name="legalName" required placeholder="ООО «Компания»" /></label>
          <div className="form-row">
            <label>ИНН<input name="inn" required inputMode="numeric" placeholder="10 или 12 цифр" /></label>
            <label>КПП<input name="kpp" inputMode="numeric" placeholder="9 цифр" /></label>
          </div>
          <label>Контактное лицо<input name="contactName" required placeholder="Имя и фамилия" /></label>
          <label>Телефон<input name="phone" type="tel" placeholder="+7 000 000-00-00" /></label>
        </>
      ) : null}
      <label>Электронная почта<input name="email" required type="email" placeholder="name@company.ru" /></label>
      <label>Пароль<input name="password" required type="password" minLength={8} placeholder="Не менее 8 символов" /></label>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
      <button className="button button-primary" type="submit" disabled={busy}>
        {busy ? 'Отправка…' : mode === 'login' ? 'Войти' : 'Отправить заявку'}
      </button>
      <span>{mode === 'login' ? <>Нет аккаунта? <Link href="/register">Зарегистрироваться</Link></> : <>Уже зарегистрированы? <Link href="/login">Войти</Link></>}</span>
    </form>
  )
}
