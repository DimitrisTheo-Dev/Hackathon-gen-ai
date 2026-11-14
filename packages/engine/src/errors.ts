/** Error codes are the shared studio contract (`errorSchema` in packages/contracts). */
export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "revision_conflict"
  | "idempotency_conflict"
  | "approval_required"
  | "stale_manifest"
  | "quota_exceeded"
  | "unsupported"
  | "provider_unavailable"
  | "validation_error"
  | "unknown_outcome";

const statusByCode: Record<ErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  revision_conflict: 409,
  idempotency_conflict: 409,
  approval_required: 403,
  stale_manifest: 409,
  quota_exceeded: 429,
  unsupported: 422,
  provider_unavailable: 503,
  validation_error: 400,
  unknown_outcome: 502,
};

export class EngineError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly reviewUrl: string | null;
  constructor(
    code: ErrorCode,
    message: string,
    details: { retryAfterSeconds?: number | null; reviewUrl?: string | null; status?: number } = {},
  ) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    this.status = details.status ?? statusByCode[code];
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
    this.reviewUrl = details.reviewUrl ?? null;
  }
  toBody() {
    return {
      error: {
        code: this.code,
        message: this.message,
        retryAfterSeconds: this.retryAfterSeconds,
        reviewUrl: this.reviewUrl,
      },
    };
  }
}

/** Unique-constraint violation surfaced by a store. Callers decide whether it is a replay or a conflict. */
export class StoreConflict extends Error {
  constructor(readonly table: string) {
    super(`Unique constraint violated on ${table}`);
    this.name = "StoreConflict";
  }
}

export function deny(message = "You do not have access to this workspace resource."): never {
  // Wrong-tenant lookups are reported as not_found so object existence is never disclosed.
  throw new EngineError("not_found", message);
}
