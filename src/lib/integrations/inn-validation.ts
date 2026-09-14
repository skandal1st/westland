/**
 * INN validation port. The real provider (e.g. DaData) is a TBD decision; it
 * lives behind this boundary so the domain never depends on a specific vendor.
 * The mock enforces only the structural rule (10 or 12 digits) and is the
 * default until a provider is configured.
 */
export type InnValidationResult = { valid: boolean; legalName?: string; reason?: string }

export interface InnValidator {
  validate(inn: string): Promise<InnValidationResult>
}

export const mockInnValidator: InnValidator = {
  async validate(inn: string): Promise<InnValidationResult> {
    const valid = /^(\d{10}|\d{12})$/.test(inn)
    return valid ? { valid } : { valid: false, reason: 'ИНН должен содержать 10 или 12 цифр' }
  },
}

export function getInnValidator(): InnValidator {
  // Future: select a real adapter from profile/env. Mock by default.
  return mockInnValidator
}
