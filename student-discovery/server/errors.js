// RFC 7807 problem details.
export class AppError extends Error {
  constructor(status, type, title, detail, extra = {}) {
    super(detail || title);
    this.status = status;
    this.type = type;
    this.title = title;
    this.detail = detail;
    this.extra = extra;
  }
}

export const badRequest = (type, detail, extra) => new AppError(400, type, 'Bad request', detail, extra);
export const unauthorized = (detail = 'Sign in required.') => new AppError(401, 'unauthenticated', 'Authentication required', detail);
export const forbidden = (reason, detail, securityEvent) =>
  new AppError(403, 'access_denied', 'Access denied', detail || 'You are not allowed to do this.', { reason, securityEvent });
export const notFound = (what = 'resource') => new AppError(404, 'not_found', 'Not found', `${what} was not found.`);
export const conflict = (type, detail, extra) => new AppError(409, type, 'Conflict', detail, extra);
export const unprocessable = (type, detail, extra) => new AppError(422, type, 'Unprocessable', detail, extra);

export function toProblem(err, requestId) {
  return {
    type: `urn:nextmind:discovery:${err.type}`,
    title: err.title,
    status: err.status,
    detail: err.detail,
    code: err.type,
    request_id: requestId,
    ...(err.extra?.reason ? { reason: err.extra.reason } : {}),
    ...(err.extra?.public ?? {}),
  };
}
