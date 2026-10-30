import type { HighlighterCore } from 'shiki/core';

let hl: Promise<HighlighterCore> | null = null;

const LANG_MAP: Record<string, string> = {
  shellscript: 'bash', docker: 'dockerfile', dotenv: 'ini', text: 'text', hcl: 'hcl', 'objective-c': 'objective-c', jsonc: 'jsonc',
};

function getHighlighter() {
  hl ??= (async () => {
    const { createHighlighterCore } = await import('shiki/core');
    const { createJavaScriptRegexEngine } = await import('shiki/engine/javascript');
    const { bundledThemes } = await import('shiki/themes');
    return createHighlighterCore({
      themes: [bundledThemes['github-light'](), bundledThemes['github-dark-dimmed']()],
      langs: [],
      engine: createJavaScriptRegexEngine(),
    });
  })();
  return hl;
}

const loaded = new Set<string>();

export async function highlight(code: string, lang: string | null | undefined): Promise<string | null> {
  const id = LANG_MAP[lang ?? ''] ?? lang ?? 'text';
  try {
    const h = await getHighlighter();
    if (id !== 'text' && !loaded.has(id)) {
      const { bundledLanguages } = await import('shiki/langs');
      const loader = (bundledLanguages as Record<string, any>)[id];
      if (!loader) return null;
      await h.loadLanguage(loader);
      loaded.add(id);
    }
    return h.codeToHtml(code, { lang: loaded.has(id) ? id : 'text', themes: { light: 'github-light', dark: 'github-dark-dimmed' }, defaultColor: false });
  } catch {
    return null;
  }
}
