/** Expected integration contract failure, safe to expose as a stable code. */
export class IntegrationInputError extends Error {
  constructor(public code: string, public status = 409) { super(code); this.name = 'IntegrationInputError' }
}
