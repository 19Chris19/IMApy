export class PersonalAuthError extends Error {
  constructor(code, { outcomeUnknown = false } = {}) {
    super(code);
    this.name = 'PersonalAuthError';
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
    this.retryable = false;
  }
}
export const fail = (code, details) => { throw new PersonalAuthError(code, details); };
export function publicError(error) {
  return error instanceof PersonalAuthError ? error : new PersonalAuthError('personal_operation_failed');
}
