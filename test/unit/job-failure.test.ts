import { describe, expect, it, vi } from 'vitest';
import { APIError, APIConnectionTimeoutError } from 'openai';
import { z } from 'zod';

import {
  jobErrorDiagnostics,
  logJobFailure,
} from '../../src/jobs/job-failure.js';

const { log } = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('pino', () => ({ default: () => ({ error: log }) }));

describe('job failure diagnostics', () => {
  it('logs provider metadata and job identity without the error payload', () => {
    const error = new APIError(
      429,
      {
        message: 'private conversation and sk-secret',
        code: 'insufficient_quota',
        type: 'tokens',
        param: 'private input',
      },
      undefined,
      new Headers({ 'x-request-id': 'req_12345678' }),
    );
    logJobFailure(
      {
        jobKind: 'context',
        jobId: 136,
        attempt: 6,
        tier: 'long-term',
        stage: 'summarization',
      },
      error,
    );
    expect(log).toHaveBeenLastCalledWith(
      expect.objectContaining({
        jobKind: 'context',
        jobId: 136,
        attempt: 6,
        stage: 'summarization',
        errors: [
          expect.objectContaining({
            code: 'insufficient_quota',
            httpStatus: 429,
            requestId: 'req_12345678',
          }),
        ],
      }),
      'chief_job_failed',
    );
    const serialized = JSON.stringify(log.mock.calls.at(-1));
    expect(serialized).not.toContain('private');
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('headers');
  });

  it('retains known local failure reasons and bounded cause locations', () => {
    const error = new Error('context summary referenced an unknown source', {
      cause: Object.assign(new Error('SQL includes private text'), {
        name: 'SqliteError',
        code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
      }),
    });
    error.stack = `${error.name}: ${error.message}\n    at commit (/app/dist/src/context/context-store.js:160:9)`;
    const diagnostics = jobErrorDiagnostics(error);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        reason: 'context summary referenced an unknown source',
        frames: ['dist/src/context/context-store.js:160:9'],
      }),
      expect.objectContaining({
        errorType: 'SqliteError',
        code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
        reason: null,
      }),
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain('private');
  });

  it('retains validation codes without values, paths, or messages', () => {
    const result = z
      .object({ 'private-field': z.string() })
      .safeParse({ 'private-field': 123 });
    if (result.success) throw new Error('expected validation failure');

    expect(jobErrorDiagnostics(result.error)).toEqual([
      expect.objectContaining({
        errorType: 'ZodError',
        validationCodes: ['invalid_type'],
      }),
    ]);
    expect(JSON.stringify(jobErrorDiagnostics(result.error))).not.toContain(
      'private-field',
    );
  });

  it('traces timeouts and bounded cyclic or primitive causes safely', () => {
    const timeout = new APIConnectionTimeoutError();
    const wrapper = new Error('private wrapper', { cause: timeout });
    timeout.cause = wrapper;
    expect(
      jobErrorDiagnostics(wrapper).map(({ errorType }) => errorType),
    ).toEqual(['Error', 'APIConnectionTimeoutError']);
    expect(jobErrorDiagnostics('sk-secret')).toEqual([
      expect.objectContaining({ errorType: 'UnknownError', reason: null }),
    ]);
    expect(jobErrorDiagnostics(null)).toEqual([]);
    let chain = new Error('private');
    for (let depth = 0; depth < 10; depth += 1) {
      chain = new Error('private', { cause: chain });
    }

    expect(jobErrorDiagnostics(chain)).toHaveLength(4);
  });

  it('excludes forged frames inside multiline error messages', () => {
    const error = new Error('private\n    at fake (/app/src/sk-secret.ts:1:1)');
    error.stack = `${error.name}: ${error.message}\n    at real (/app/src/context/context-store.ts:160:9)`;
    expect(jobErrorDiagnostics(error)[0]?.frames).toEqual([
      'src/context/context-store.ts:160:9',
    ]);
    expect(JSON.stringify(jobErrorDiagnostics(error))).not.toContain(
      'sk-secret',
    );
  });

  it('drops untrusted names, codes, and malformed provider metadata', () => {
    const error = Object.assign(new Error('sk-secret'), {
      name: 'sk-secret',
      code: 'sk-secret',
      status: 999,
      request_id: 'sk-secret',
    });
    expect(jobErrorDiagnostics(error)).toEqual([
      expect.objectContaining({
        errorType: 'UnknownError',
        code: null,
        httpStatus: null,
        requestId: null,
      }),
    ]);
    expect(JSON.stringify(jobErrorDiagnostics(error))).not.toContain(
      'sk-secret',
    );
  });
});
