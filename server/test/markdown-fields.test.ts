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
    ['{"markdown": "x"} extra text', '{"markdown": "x"} extra text'],
    // Cut off mid-escape: complete escapes decoded in one pass, the dangling one dropped.
    ['{"markdown": "a\\\\nb\\tc \\u00e9 \\', 'a\\nb\tc é '],
    ['{"markdown": "tab\\tthen \\u00', 'tab\tthen '],
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
  const files = new Set(['datasette/publish/heroku.py', 'datasette/publish/cloudrun.py', 'datasette/__init__.py', 'setup.py', 'src/a.ts']);
  const isFile = (p: string) => files.has(p);

  it.each([
    // The onboarding text that was left unlinked.
    ['via [datasette/publish/heroku.py] and [datasette/publish/cloudrun.py]', 'via [datasette/publish/heroku.py](cite:datasette%2Fpublish%2Fheroku.py::) and [datasette/publish/cloudrun.py](cite:datasette%2Fpublish%2Fcloudrun.py::)'],
    ['see [datasette/__init__.py]', 'see [datasette/__init__.py](cite:datasette%2F__init__.py::)'],
    ['[setup.py]', '[setup.py](cite:setup.py::)'],
    ['[src/a.ts:12]', '[src/a.ts:12](cite:src%2Fa.ts:12:12)'],
    ['[src/a.ts:12-30]', '[src/a.ts:12-30](cite:src%2Fa.ts:12:30)'],
    ['[src/a.ts]: the entry point', '[src/a.ts](cite:src%2Fa.ts::): the entry point'],
  ])('%s', (md, want) => expect(linkCitations(md, isFile)).toBe(want));

  it.each([
    'built on [Node.js] and [Vue.js]',
    'reads [input/output] and handles [GET/POST], [and/or]',
    'released in [v1.2], [e.g.]',
    'a file that does not exist: [src/missing.ts]',
    'an existing [src/a.ts](https://example.com/a.ts)',
    'a reference link [src/a.ts][docs]\n\n[docs]: https://example.com/guide',
    'a shortcut reference [setup.py]\n\n[setup.py]: https://example.com/setup',
    'inline code `[src/a.ts]` and ``x [setup.py] y``',
    '```json\n{"include": ["src/a.ts", "[setup.py]"]}\n[src/a.ts:3]\n```',
    '~~~\n[src/a.ts]\n~~~',
    '- [x] done',
  ])('leaves %j as it is', (md) => expect(linkCitations(md, isFile)).toBe(md));

  it('links text after a closed code fence', () => {
    expect(linkCitations('```\n[setup.py]\n```\nsee [setup.py]', isFile)).toBe('```\n[setup.py]\n```\nsee [setup.py](cite:setup.py::)');
  });

  it('links only citations with line numbers before the file list is loaded', () => {
    expect(linkCitations('[datasette/app.py] [Node.js] [GET/POST] [src/a.ts:3]')).toBe('[datasette/app.py] [Node.js] [GET/POST] [src/a.ts:3](cite:src%2Fa.ts:3:3)');
  });
});
