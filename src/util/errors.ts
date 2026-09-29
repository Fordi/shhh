// HTTP and other API errors
import { STATUS_CODES } from "node:http";

export class HttpError extends Error {
  status: number;
  details: unknown;

  constructor(
    status: number,
    message: string = String(STATUS_CODES[status]),
    details?: unknown,
  ) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string, details?: unknown) {
    super(400, message, details);
  }
}

export class UnauthorizedError extends HttpError {
  constructor(message?: string) {
    super(401, message);
  }
}

export class ForbiddenError extends HttpError {
  constructor(message?: string) {
    super(403, message);
  }
}

export class NotFoundError extends HttpError {
  constructor(message?: string) {
    super(404, message);
  }
}

export class ConflictError extends HttpError {
  constructor(message?: string, details?: unknown) {
    super(409, message, details);
  }
}

/**
 * Not an HTTP response error - thrown for programming mistakes made while
 * defining routes/handlers themselves (e.g. misusing a builder API), never
 * as a result of request data. Should surface at development/startup time,
 * not be caught and turned into a response.
 */
export class DeveloperError extends Error {}
