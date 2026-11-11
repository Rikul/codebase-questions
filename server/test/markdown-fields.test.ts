import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ExplanationSchema, unwrapMarkdown } from '@cq/shared';
import { linkCitations } from '../../web/src/lib/citations.js';

describe('markdown fields filled by a model', () => {
  it.each([
    ['{"markdown": "Hi **there**\\n[a/b.py:1-2]"}', 'Hi **there**\n[a/b.py:1-2]'],
    ['  {"text": "wrapped"}  ', 'wrapped'],
    ['{"markdown": "cut off here', 'cut off here'],
    ['{"markdown": "escaped \\"quote\\"', 'escaped "quote"'],
    ['plain **markdown**', 'plain **markdown**'],
    ['{ not json }', '{ not json }'],
    ['{"a": 1, "b": 2}', '{"a": 1, "b": 2}'],
  ])('%j → %j', (raw, want) => expect(unwrapMarkdown(raw)).toBe(want));

  it('unwraps an object value', () => {
    expect(unwrapMarkdown({ markdown: 'obj' })).toBe('obj');
    expect(unwrapMarkdown({ only: 'one string' })).toBe('one string');
    expect(unwrapMarkdown({ a: 1 })).toEqual({ a: 1 });
  });

  it('cleans every prose field of an explanation, including cached ones', () => {
    const wrapped = (s: string) => JSON.stringify({ markdown: s });
    const parsed = ExplanationSchema.parse({
      what: wrapped('What it is'),
      howItFits: { markdown: 'How it fits' },
      whenUsed: 'When used',
      contains: [],
      callers: [],
      callees: [],
      history: { created: wrapped('Created in abc123'), evolution: wrapped('Changed'), keyCommits: [] },
    });
    expect(parsed).toMatchObject({ what: 'What it is', howItFits: 'How it fits', whenUsed: 'When used', history: { created: 'Created in abc123', evolution: 'Changed' } });
  });

  it('still describes the fields to the model as plain strings', () => {
    const j = zodToJsonSchema(ExplanationSchema, { $refStrategy: 'none' }) as any;
    expect(j.properties.what).toMatchObject({ type: 'string', description: expect.stringMatching(/main responsibility/) });
    expect(j.properties.history.properties.created.type).toBe('string');
  });
});

describe('citation links in rendered markdown', () => {
  it.each([
    // The onboarding text that was left unlinked.
    ['via [datasette/publish/heroku.py] and [datasette/publish/cloudrun.py]', 'via [datasette/publish/heroku.py](cite:datasette%2Fpublish%2Fheroku.py::) and [datasette/publish/cloudrun.py](cite:datasette%2Fpublish%2Fcloudrun.py::)'],
    ['see [datasette/__init__.py]', 'see [datasette/__init__.py](cite:datasette%2F__init__.py::)'],
    ['[setup.py]', '[setup.py](cite:setup.py::)'],
    ['[src/a.ts:12]', '[src/a.ts:12](cite:src%2Fa.ts:12:12)'],
    ['[src/a.ts:12-30]', '[src/a.ts:12-30](cite:src%2Fa.ts:12:30)'],
  ])('%s', (md, want) => expect(linkCitations(md)).toBe(want));

  it.each([
    'released in [v1.2]',
    'abbreviations [e.g.] stay',
    'an existing [link.md](https://example.com/link.md)',
    '- [x] done',
  ])('leaves %s as it is', (md) => expect(linkCitations(md)).toBe(md));
});
