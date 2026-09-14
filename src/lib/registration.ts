import bcrypt from 'bcryptjs'
import { prisma } from '@/lib/db'
import { getActiveStore } from '@/lib/store'
import { getInnValidator } from '@/lib/integrations/inn-validation'
import { AuditAction, recordAudit } from '@/lib/audit'
import type { SessionUser } from '@/lib/authz'

export class RegistrationError extends Error {
  constructor(public code: 'EMAIL_TAKEN' | 'ALREADY_PENDING' | 'INVALID_INN' | 'NOT_FOUND' | 'NOT_PENDING') {
    super(code)
    this.name = 'RegistrationError'
  }
}

export type RegistrationInput = {
  email: string
  password: string
  contactName: string
  phone?: string
  legalName: string
  inn: string
  kpp?: string
}

/**
 * Create a pending B2B application. If the store policy is AUTO_APPROVE the
 * request is approved immediately. An email already belonging to an active user
 * or an outstanding pending request is rejected.
 */
export async function createRegistrationRequest(input: RegistrationInput) {
  const store = await getActiveStore()
  const email = input.email.trim().toLowerCase()

  const existingUser = await prisma.user.findUnique({ where: { storeId_email: { storeId: store.id, email } } })
  if (existingUser) throw new RegistrationError('EMAIL_TAKEN')

  const pending = await prisma.registrationRequest.findFirst({ where: { storeId: store.id, email, status: 'PENDING' } })
  if (pending) throw new RegistrationError('ALREADY_PENDING')

  const inn = input.inn.trim()
  const innCheck = await getInnValidator().validate(inn)
  if (!innCheck.valid) throw new RegistrationError('INVALID_INN')

  const passwordHash = await bcrypt.hash(input.password, 10)
  const request = await prisma.registrationRequest.create({
    data: {
      storeId: store.id,
      email,
      passwordHash,
      contactName: input.contactName.trim(),
      phone: input.phone?.trim() || null,
      legalName: input.legalName.trim(),
      inn,
      kpp: input.kpp?.trim() || null,
      status: 'PENDING',
    },
  })

  const settings = await prisma.appSettings.findUnique({ where: { storeId: store.id } })
  if (settings?.registrationMode === 'AUTO_APPROVE') {
    return approveRegistration(request.id, { actor: null, priceGroupId: settings.defaultPriceGroupId ?? undefined })
  }
  return request
}

/**
 * Approve a pending request: create/reuse the Customer (by INN) and the buyer
 * User inside one transaction, assign the price group, and audit the action.
 * Idempotency guard: only a PENDING request can be approved.
 */
export async function approveRegistration(
  requestId: string,
  options: { actor: SessionUser | null; priceGroupId?: string },
) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.registrationRequest.findUnique({ where: { id: requestId } })
    if (!request) throw new RegistrationError('NOT_FOUND')
    if (request.status !== 'PENDING') throw new RegistrationError('NOT_PENDING')

    const customer = await tx.customer.upsert({
      where: { storeId_inn: { storeId: request.storeId, inn: request.inn } },
      update: { legalName: request.legalName, kpp: request.kpp },
      create: {
        storeId: request.storeId,
        displayName: request.legalName,
        legalName: request.legalName,
        inn: request.inn,
        kpp: request.kpp,
      },
    })

    const user = await tx.user.create({
      data: {
        storeId: request.storeId,
        customerId: customer.id,
        priceGroupId: options.priceGroupId ?? null,
        email: request.email,
        passwordHash: request.passwordHash,
        name: request.contactName,
        phone: request.phone,
        role: 'BUYER',
        status: 'ACTIVE',
      },
    })

    const updated = await tx.registrationRequest.update({
      where: { id: request.id },
      data: {
        status: 'APPROVED',
        reviewedById: options.actor?.id ?? null,
        reviewedAt: new Date(),
        assignedPriceGroupId: options.priceGroupId ?? null,
        createdUserId: user.id,
        createdCustomerId: customer.id,
      },
    })

    if (options.priceGroupId) {
      await tx.buyerPriceAssignment.upsert({
        where: { customerId: customer.id },
        update: { priceGroupId: options.priceGroupId, assignedById: options.actor?.id ?? null },
        create: { storeId: request.storeId, customerId: customer.id, priceGroupId: options.priceGroupId, assignedById: options.actor?.id ?? null },
      })
    }

    await recordAudit(tx, {
      storeId: request.storeId,
      actor: options.actor,
      action: AuditAction.RegistrationApproved,
      targetType: 'RegistrationRequest',
      targetId: request.id,
      summary: `Approved ${request.email} (${request.legalName})`,
      metadata: { userId: user.id, customerId: customer.id, priceGroupId: options.priceGroupId ?? null },
    })

    return updated
  })
}

export async function rejectRegistration(
  requestId: string,
  options: { actor: SessionUser | null; comment?: string },
) {
  return prisma.$transaction(async (tx) => {
    const request = await tx.registrationRequest.findUnique({ where: { id: requestId } })
    if (!request) throw new RegistrationError('NOT_FOUND')
    if (request.status !== 'PENDING') throw new RegistrationError('NOT_PENDING')

    const updated = await tx.registrationRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        reviewedById: options.actor?.id ?? null,
        reviewedAt: new Date(),
        comment: options.comment?.trim() || null,
      },
    })

    await recordAudit(tx, {
      storeId: request.storeId,
      actor: options.actor,
      action: AuditAction.RegistrationRejected,
      targetType: 'RegistrationRequest',
      targetId: request.id,
      summary: `Rejected ${request.email}`,
      metadata: { comment: options.comment ?? null },
    })

    return updated
  })
}
