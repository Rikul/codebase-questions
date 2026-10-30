import { AsyncLocalStorage } from 'node:async_hooks';
import { ZodError } from 'zod';

const context = new AsyncLocalStorage<{ jobId: string; repoId: string }>();
export function withJobLogs<T>(jobId: string, repoId: string, run: () => T): T {
  return context.run({ jobId, repoId }, run);
}

/** Log metadata only: never pass prompts, responses, headers or credential objects. */
export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...context.getStore(), ...fields }));
}

/** Deliberately omit error messages/bodies, which SDKs may populate with request data. */
export function errorDetails(error: unknown): Record<string, unknown> {
  if (error instanceof ZodError) {
    return {
      errorType: 'ResponseValidationError',
      issues: error.issues.map((issue) => ({
        path: issue.path.join('.'), code: issue.code,
        ...('expected' in issue ? { expected: issue.expected } : {}),
        // Zod invalid_type uses a type name here, never the actual response value.
        ...(issue.code === 'invalid_type' ? { receivedType: issue.received } : {}),
        ...(issue.code === 'invalid_enum_value' ? { allowedValues: issue.options } : {}),
      })),
    };
  }
  const err = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  return {
    errorType: error instanceof SyntaxError ? 'ResponseSyntaxError' : error instanceof Error ? error.name : 'UnknownError',
    ...(typeof err?.status === 'number' ? { status: err.status } : {}),
    ...(typeof err?.code === 'string' && /^[A-Z_0-9]{1,40}$/.test(err.code) ? { code: err.code } : {}),
  };
}
