'use client'

import Link from 'next/link'
import { useState } from 'react'

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const [sent, setSent] = useState(false)
  if (sent) return <div className="auth-success"><h1>Заявка принята</h1><p>После проверки реквизитов сотрудник Westside откроет доступ и назначит ценовую группу.</p><Link className="button button-primary" href="/">На главную</Link></div>
  return (
    <form className="auth-card" onSubmit={(event) => { event.preventDefault(); mode === 'register' ? setSent(true) : window.location.assign('/catalog') }}>
      <h1>{mode === 'login' ? 'Вход для партнёров' : 'Регистрация компании'}</h1>
      <p>{mode === 'login' ? 'Каталог, цены и остатки доступны после авторизации.' : 'Укажите данные юридического лица. Политика подтверждения настраивается в бек-офисе.'}</p>
      {mode === 'register' ? <><label>Название компании<input required placeholder="ООО «Компания»" /></label><div className="form-row"><label>ИНН<input required inputMode="numeric" placeholder="10 или 12 цифр" /></label><label>КПП<input inputMode="numeric" placeholder="9 цифр" /></label></div><label>Контактное лицо<input required placeholder="Имя и фамилия" /></label><label>Телефон<input required type="tel" placeholder="+7 000 000-00-00" /></label></> : null}
      <label>Электронная почта<input required type="email" placeholder="name@company.ru" /></label>
      <label>Пароль<input required type="password" minLength={8} placeholder="Не менее 8 символов" /></label>
      <button className="button button-primary" type="submit">{mode === 'login' ? 'Войти' : 'Отправить заявку'}</button>
      <span>{mode === 'login' ? <>Нет аккаунта? <Link href="/register">Зарегистрироваться</Link></> : <>Уже зарегистрированы? <Link href="/login">Войти</Link></>}</span>
    </form>
  )
}
