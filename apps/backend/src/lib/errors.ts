export class AppError extends Error {
  statusCode: number;
  code: string;

  constructor(statusCode: number, message: string, code = "APP_ERROR") {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super(404, message, "NOT_FOUND");
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden") {
    super(403, message, "FORBIDDEN");
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized") {
    super(401, message, "UNAUTHORIZED");
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request") {
    super(400, message, "BAD_REQUEST");
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict") {
    super(409, message, "CONFLICT");
  }
}

export class TooManyRequestsError extends AppError {
  constructor(message = "Too many requests") {
    super(429, message, "TOO_MANY_REQUESTS");
  }
}

/**
 * A block with a catalogue code.
 *
 * The code is the point: the same identifier appears in the user's error, the owner console's
 * searchable catalogue, and the AccountFlag row, so "why can't I sign in" resolves to one
 * explanation instead of three different guesses. The user-facing text comes from the catalogue
 * rather than the call site, so it can never drift between them.
 */
export class BlockedError extends AppError {
  reasonCode: string;

  constructor(reasonCode: string, message?: string) {
    super(403, message ?? "Blocked", "BLOCKED");
    this.reasonCode = reasonCode;
  }
}

/**
 * A platform ban. Distinct from ForbiddenError so the client can render the dedicated ban screen
 * (with the reason, expiry, and appeal route) rather than a generic "forbidden" toast — the `code`
 * is what the frontend switches on, and `details` carries what the banned person is entitled to
 * know about why.
 */
export class BannedError extends AppError {
  details: {
    reason: string;
    scope: string;
    expiresAt: string | null;
    banId?: string;
    appealStatus?: string;
  };

  constructor(details: BannedError["details"]) {
    super(403, "Access denied", "PLATFORM_BANNED");
    this.details = details;
  }
}
