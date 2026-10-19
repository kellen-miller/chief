import pino from 'pino';

export type JobStage =
  | 'configuration'
  | 'source-load'
  | 'summarization'
  | 'embedding'
  | 'extraction'
  | 'mutation-preparation'
  | 'persistence'
  | 'accounting'
  | 'journal-upload';

export interface JobFailure {
  readonly jobKind:
    'context' | 'memory' | 'explicit-memory' | 'backfill' | 'forget-journal';
  readonly jobId?: number;
  readonly attempt?: number;
  readonly stage: JobStage;
  readonly tier?: string;
}

interface JobErrorDiagnostic {
  readonly errorType: string;
  readonly reason: string | null;
  readonly code: string | null;
  readonly httpStatus: number | null;
  readonly requestId: string | null;
  readonly frames: readonly string[];
  readonly validationCodes: readonly string[];
}

const logger = pino();
const errorTypes = new Set([
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ZodError',
  'SqliteError',
  'APIError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'APIUserAbortError',
  'BadRequestError',
  'AuthenticationError',
  'PermissionDeniedError',
  'NotFoundError',
  'ConflictError',
  'UnprocessableEntityError',
  'RateLimitError',
  'InternalServerError',
  'AbortError',
  'TimeoutError',
  'ModelBehaviorError',
  'UserError',
  'MaxTurnsExceededError',
  'ContextPersistenceError',
  'MemoryPersistenceError',
]);
const errorCodes = new Set([
  'invalid_json_schema',
  'model_not_found',
  'unsupported_parameter',
  'context_length_exceeded',
  'insufficient_quota',
  'rate_limit_exceeded',
  'invalid_api_key',
  'content_policy_violation',
  'server_error',
  'invalid_request_error',
  'invalid_value',
  'unsupported_value',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'SQLITE_ERROR',
  'SQLITE_BUSY',
  'SQLITE_LOCKED',
  'SQLITE_FULL',
  'SQLITE_IOERR',
  'SQLITE_CORRUPT',
  'SQLITE_READONLY',
  'SQLITE_CONSTRAINT',
  'SQLITE_CONSTRAINT_UNIQUE',
  'SQLITE_CONSTRAINT_FOREIGNKEY',
  'SQLITE_CONSTRAINT_CHECK',
  'SQLITE_CONSTRAINT_NOTNULL',
  'SQLITE_CONSTRAINT_TRIGGER',
  'SQLITE_CONSTRAINT_PRIMARYKEY',
]);
// Only exact application-owned messages are safe. Provider messages and Zod
// messages can contain submitted text, credentials, or generated output.
const errorReasons = new Set([
  'context summarization returned no structured output',
  'context summarization requires sources',
  'memory extraction returned no structured output',
  'OpenAI returned an invalid memory embedding',
  'context summary referenced an unknown source',
  'backfill summary referenced an unknown source',
  'backfill topic referenced an unknown source',
  'context segmentation did not converge',
  'context segmentation produced no summary',
  'context job lease is no longer current',
  'context document revision must increase',
  'context document requires lineage',
  'higher context tier requires parent lineage',
  'higher context tier requires parent-only lineage',
  'context document requires source revision checksum',
  'context document source revision changed',
  'context document source is unavailable',
  'context document source is tombstoned',
  'context document parent is unavailable',
  'higher context tier requires final parents',
  'context document is tombstoned',
  'backfill aggregate input exceeded its hard token bound',
  'backfill segment is no longer current',
  'backfill source is tombstoned',
  'backfill source revision changed',
  'forget journal uploader is unavailable',
  'context providers are unavailable',
  'durable memory persistence failed',
]);
const validationCodes = new Set([
  'invalid_type',
  'too_big',
  'too_small',
  'invalid_format',
  'not_multiple_of',
  'unrecognized_keys',
  'invalid_union',
  'invalid_key',
  'invalid_element',
  'invalid_value',
  'custom',
]);

export function jobErrorDiagnostics(
  error: unknown,
): readonly JobErrorDiagnostic[] {
  const diagnostics: JobErrorDiagnostic[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current !== null &&
    current !== undefined &&
    !seen.has(current) &&
    diagnostics.length < 4
  ) {
    seen.add(current);
    const value =
      typeof current === 'object' ? (current as Record<string, unknown>) : {};
    const name =
      current instanceof Error
        ? current.name === 'Error'
          ? current.constructor.name
          : current.name
        : '';
    const requestId = value.requestID ?? value.request_id;
    const message = current instanceof Error ? current.message : '';
    const header =
      current instanceof Error ? `${current.name}: ${message}` : '';
    const stack =
      current instanceof Error && current.stack?.startsWith(header)
        ? current.stack.slice(header.length)
        : undefined;
    diagnostics.push({
      errorType: errorTypes.has(name) ? name : 'UnknownError',
      reason: errorReasons.has(message) ? message : null,
      code:
        typeof value.code === 'string' && errorCodes.has(value.code)
          ? value.code
          : null,
      httpStatus:
        typeof value.status === 'number' &&
        Number.isInteger(value.status) &&
        value.status >= 400 &&
        value.status <= 599
          ? value.status
          : null,
      requestId:
        typeof requestId === 'string' &&
        /^req_[a-zA-Z0-9]{8,80}$/u.test(requestId)
          ? requestId
          : null,
      // The complete message (including embedded newlines) was removed above.
      // Keep only frame locations, never absolute paths or frame labels.
      frames: [
        ...new Set(
          stack
            ?.split('\n')
            .slice(1)
            .flatMap((line) =>
              /^\s+at /u.test(line)
                ? (line.match(/(?:src|dist)\/[a-zA-Z0-9_./-]+:\d+:\d+/gu) ?? [])
                : [],
            ) ?? [],
        ),
      ].slice(0, 5),
      validationCodes:
        name === 'ZodError' && Array.isArray(value.issues)
          ? [
              ...new Set(
                value.issues.flatMap((issue: unknown) => {
                  if (
                    typeof issue !== 'object' ||
                    issue === null ||
                    !('code' in issue) ||
                    typeof issue.code !== 'string'
                  )
                    return [];
                  return validationCodes.has(issue.code) ? [issue.code] : [];
                }),
              ),
            ].slice(0, 10)
          : [],
    });
    current = value.cause;
  }

  return diagnostics;
}

export function logJobFailure(job: JobFailure, error: unknown): void {
  logger.error(
    { ...job, errors: jobErrorDiagnostics(error) },
    'chief_job_failed',
  );
}
