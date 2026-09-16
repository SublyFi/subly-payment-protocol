export class SublyError extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly details: unknown;

  constructor(code: string, message: string, httpStatus = 400, details?: unknown) {
    super(message);
    this.name = "SublyError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.details = details;
  }
}

/** An expected policy refusal whose newly created approval must be committed. */
export class ApprovalRequiredError extends SublyError {
  constructor(code: string, message: string, details: unknown) {
    super(code, message, 409, details);
    this.name = "ApprovalRequiredError";
  }
}

export function badRequest(code: string, message: string, details?: unknown): SublyError {
  return new SublyError(code, message, 400, details);
}

export function notFound(code: string, message: string, details?: unknown): SublyError {
  return new SublyError(code, message, 404, details);
}

export function conflict(code: string, message: string, details?: unknown): SublyError {
  return new SublyError(code, message, 409, details);
}

export function forbidden(
  code: string,
  message: string,
  details?: unknown
): SublyError {
  return new SublyError(code, message, 403, details);
}

export function unavailable(
  code: string,
  message: string,
  details?: unknown
): SublyError {
  return new SublyError(code, message, 501, details);
}
