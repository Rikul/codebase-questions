import { describe, expect, it } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { ExplanationSchema, unwrapMarkdown } from '@cq/shared';
import { citeHref, linkCitations, pathResolver } from '../../web/src/lib/citations.js';

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
    expect(unwrapMarkdown({ example: 'value' })).toEqual({ example: 'value' }); // not a wrapper key
    expect(unwrapMarkdown({ text: 'hi', id: 3 })).toEqual({ text: 'hi', id: 3 }); // more than the wrapper
    expect(unwrapMarkdown('{"text": "hi", "id": 3}')).toBe('{"text": "hi", "id": 3}');
    expect(unwrapMarkdown('{"example": "value"}')).toBe('{"example": "value"}');
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
  const files = new Set([
    'datasette/publish/heroku.py',
    'datasette/publish/cloudrun.py',
    'datasette/__init__.py',
    'setup.py',
    'src/a.ts',
    'packages/excalidraw/components/App.tsx',
    'excalidraw-app/App.tsx',
    'packages/excalidraw/actions/actionToggleShapeSwitch.tsx',
  ]);
  const link = (md: string) => linkCitations(md, pathResolver(files, md));
  /** The markdown a citation becomes: shown as written, opening `path`. */
  const L = (label: string, path = label.replace(/:.*/, ''), s?: string, e?: string) => `[${label}](${citeHref(path, s, e, label)})`;

  it.each([
    // The onboarding text that was left unlinked.
    ['via [datasette/publish/heroku.py] and [datasette/publish/cloudrun.py]', `via ${L('datasette/publish/heroku.py')} and ${L('datasette/publish/cloudrun.py')}`],
    ['see [datasette/__init__.py]', `see ${L('datasette/__init__.py')}`],
    ['[setup.py]', L('setup.py')],
    ['[src/a.ts:12]', L('src/a.ts:12', 'src/a.ts', '12')],
    ['[src/a.ts:12-30]', L('src/a.ts:12-30', 'src/a.ts', '12', '30')],
    ['[src/a.ts]: the entry point', `${L('src/a.ts')}: the entry point`],
    ['[setup.py]: Config', `${L('setup.py')}: Config`],
    // Several ranges: linked at the first, shown as written.
    ['[src/a.ts:12-30, 40]', L('src/a.ts:12-30, 40', 'src/a.ts', '12', '30')],
    // A unique file name or partial path resolves to the full path.
    ['[actionToggleShapeSwitch.tsx:23-31]', L('actionToggleShapeSwitch.tsx:23-31', 'packages/excalidraw/actions/actionToggleShapeSwitch.tsx', '23', '31')],
    ['[components/App.tsx:5]', L('components/App.tsx:5', 'packages/excalidraw/components/App.tsx', '5')],
    ['[./src/a.ts:2]', L('./src/a.ts:2', 'src/a.ts', '2')],
  ])('%s', (md, want) => expect(link(md)).toBe(want));

  it('resolves a file name several files share to the one named in full elsewhere in the text', () => {
    // From the reported answer: App.tsx exists twice; the full path was cited earlier.
    const md = 'gated by [packages/excalidraw/components/App.tsx:2377-2378, 2740]. Press Escape [App.tsx:5190-5191].';
    expect(link(md)).toBe(
      `gated by ${L('packages/excalidraw/components/App.tsx:2377-2378, 2740', 'packages/excalidraw/components/App.tsx', '2377', '2378')}. Press Escape ${L('App.tsx:5190-5191', 'packages/excalidraw/components/App.tsx', '5190', '5191')}.`,
    );
  });

  it('only counts whole-path mentions when picking between files with the same name', () => {
    const nested = new Set(['src/App.tsx', 'packages/demo/src/App.tsx']);
    const md = 'See [packages/demo/src/App.tsx:10]. Then [App.tsx:20].';
    // `src/App.tsx` is only part of the longer path, so the cited file is the one named in full.
    expect(pathResolver(nested, md)!('App.tsx')).toBe('packages/demo/src/App.tsx');
    // A path not in the repo that ends with a real one does not count as naming it.
    expect(pathResolver(nested, 'See lib/src/App.tsx and [App.tsx:3]')!('App.tsx')).toBeNull();
    expect(pathResolver(nested, 'See (src/App.tsx) and [App.tsx:3]')!('App.tsx')).toBe('src/App.tsx');
  });

  it('treats a bare name that is also a root-level file as ambiguous when nested files share it', () => {
    const withRoot = new Set(['App.tsx', 'src/App.tsx', 'README.md', 'docs/guide/README.md', 'setup.py']);
    // A nested file named in full elsewhere wins over the root file.
    expect(pathResolver(withRoot, 'See [src/App.tsx:10]. Then [App.tsx:20].')!('App.tsx')).toBe('src/App.tsx');
    // Nothing to pick one: stays text instead of guessing the root file.
    expect(pathResolver(withRoot, 'Then [App.tsx:20].')!('App.tsx')).toBeNull();
    expect(pathResolver(withRoot, 'Read [README.md]')!('README.md')).toBeNull();
    // Unambiguous root files and paths with a folder are exact.
    expect(pathResolver(withRoot, '[setup.py:3]')!('setup.py')).toBe('setup.py');
    expect(pathResolver(withRoot, '[src/App.tsx:3]')!('src/App.tsx')).toBe('src/App.tsx');
    expect(pathResolver(withRoot, '[./App.tsx:3]')!('./App.tsx')).toBeNull();
  });

  it.each([
    'built on [Node.js] and [Vue.js]',
    'reads [input/output] and handles [GET/POST], [and/or]',
    'released in [v1.2], [e.g.]',
    'a file that does not exist: [src/missing.ts] or [src/missing.ts:4]',
    'a name several files share, with nothing to pick one: [App.tsx:5190]',
    'an existing [src/a.ts](https://example.com/a.ts)',
    'a reference link [src/a.ts][docs]\n\n[docs]: https://example.com/guide',
    'a shortcut reference [setup.py]\n\n[setup.py]: https://example.com/setup',
    'inline code `[src/a.ts]` and ``x [setup.py] y``',
    '```json\n{"include": ["src/a.ts", "[setup.py]"]}\n[src/a.ts:3]\n```',
    '~~~\n[src/a.ts]\n~~~',
    '- [x] done',
  ])('leaves %j as it is', (md) => expect(link(md)).toBe(md));

  it('ignores reference definitions inside code blocks', () => {
    expect(link('see [setup.py]\n\n```\n[setup.py]: https://example.com\n```')).toBe(`see ${L('setup.py')}\n\n\`\`\`\n[setup.py]: https://example.com\n\`\`\``);
  });

  it('links text after a closed code fence', () => {
    expect(link('```\n[setup.py]\n```\nsee [setup.py]')).toBe(`\`\`\`\n[setup.py]\n\`\`\`\nsee ${L('setup.py')}`);
  });

  it('links only citations with line numbers, as written, before the file list is loaded', () => {
    expect(linkCitations('[datasette/app.py] [Node.js] [GET/POST] [src/a.ts:3]')).toBe(`[datasette/app.py] [Node.js] [GET/POST] ${L('src/a.ts:3', 'src/a.ts', '3')}`);
  });

  it('resolves paths for code spans the same way', () => {
    const resolve = pathResolver(files, 'see packages/excalidraw/components/App.tsx')!;
    expect(resolve('App.tsx')).toBe('packages/excalidraw/components/App.tsx');
    expect(pathResolver(files, 'no full path here')!('App.tsx')).toBeNull();
    expect(resolve('setup.py')).toBe('setup.py');
    expect(resolve('missing.py')).toBeNull();
    expect(pathResolver(null, '')).toBeUndefined();
  });
});
