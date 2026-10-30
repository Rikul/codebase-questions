import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { errorDetails, log, withJobLogs } from '../src/logging/index.js';

describe('analysis logging', () => {
  it('keeps concurrent job context separate', async () => {
    const output = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    try {
      await Promise.all(['a', 'b'].map((id) => withJobLogs(`job-${id}`, `repo-${id}`, async () => {
        await Promise.resolve();
        log('info', 'test.event', { operation: id });
      })));
      expect(output.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
        expect.objectContaining({ jobId: 'job-a', repoId: 'repo-a', operation: 'a' }),
        expect.objectContaining({ jobId: 'job-b', repoId: 'repo-b', operation: 'b' }),
      ]);
    } finally { output.mockRestore(); }
  });

  it('omits response contents, SDK messages, headers and credentials', () => {
    const response = z.object({ severity: z.enum(['low', 'high']) }).safeParse({ severity: 'sensitive-response' });
    expect(response.success).toBe(false);
    if (!response.success) {
      expect(errorDetails(response.error)).toMatchObject({ issues: [{ path: 'severity', code: 'invalid_enum_value', allowedValues: ['low', 'high'] }] });
      expect(JSON.stringify(errorDetails(response.error))).not.toContain('sensitive-response');
    }
    const sdkError = Object.assign(new Error('secret-token'), { status: 429, headers: { authorization: 'secret-token' }, body: 'source-content' });
    expect(errorDetails(sdkError)).toEqual({ errorType: 'Error', status: 429 });
  });
});
