import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonWithFallback } from '../src/llm/index.js';
import { MockProvider } from '../src/llm/mock.js';

describe('structured response fallback warnings', () => {
  it('reports the rejected field on one line and keeps the static fallback', async () => {
    const logged = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const schema = z.object({ insights: z.array(z.object({ severity: z.enum(['high', 'low']) })) });
    const provider = new MockProvider();
    provider.completeJSON = async () => schema.parse({ insights: [{ severity: null }] }) as never;
    const warnings: string[] = [];
    const result = await jsonWithFallback(provider, {
      name: 'insights_security', system: '', messages: [], schema,
      heuristic: () => ({ insights: [{ severity: 'low' as const }] }),
    }, (warning) => warnings.push(warning));
    expect(result).toEqual({ insights: [{ severity: 'low' }] });
    expect(warnings[0]).toContain('insights_security: model call failed (response validation failed: insights.0.severity:');
    expect(warnings[0]).toContain('using static analysis instead');
    expect(warnings[0]).not.toContain('\n');
    const entry = JSON.parse(logged.mock.calls[0][0] as string);
    expect(entry).toMatchObject({ event: 'llm.request.failed', operation: 'insights_security', fallback: true,
      errorType: 'ResponseValidationError', issues: [{ path: 'insights.0.severity', code: 'invalid_type', expected: "'high' | 'low'", receivedType: 'null' }] });
    expect(entry.durationMs).toBeGreaterThanOrEqual(0);
    logged.mockRestore();
  });
});
