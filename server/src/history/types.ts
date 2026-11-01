import type { CommitType } from '@cq/shared';

// Commit type from the message: conventional-commit prefixes first ("fix(api)!: …"), then merge
// commits, then the subject's first word. Anything else is 'other' (the LLM may classify it later).

const PREFIX: Record<string, CommitType> = {
  feat: 'feat', feature: 'feat',
  fix: 'fix', bugfix: 'fix', hotfix: 'fix',
  refactor: 'refactor', perf: 'refactor', style: 'refactor',
  chore: 'chore', build: 'chore', ci: 'chore', deps: 'chore', release: 'chore', revert: 'chore',
  docs: 'docs', doc: 'docs',
  test: 'test', tests: 'test',
};

const FIRST_WORD: [RegExp, CommitType][] = [
  [/^(fix|fixes|fixed|fixing|bug|bugfix|hotfix|resolve[sd]?|patch(es|ed)?|correct(s|ed)?|repair(s|ed)?)$/, 'fix'],
  [/^(add|adds|added|adding|implement(s|ed)?|introduce[sd]?|support(s|ed)?|create[sd]?|enable[sd]?|allow(s|ed)?|new)$/, 'feat'],
  [/^(refactor(s|ed|ing)?|clean(s|ed|up)?|cleanup|rename[sd]?|move[sd]?|extract(s|ed)?|simplif(y|ies|ied)|restructure[sd]?|reorgani[sz]e[sd]?|rewrite|rewrote|tidy)$/, 'refactor'],
  [/^(bump(s|ed)?|upgrade[sd]?|release[sd]?|version|lint|format(s|ted)?|typo|deps?|dependencies)$/, 'chore'],
  [/^(docs?|readme|documentation|document(s|ed)?)$/, 'docs'],
  [/^(tests?|testing|spec)$/, 'test'],
];

export function commitTypeOf(subject: string): CommitType {
  const s = subject.trim();
  const m = s.match(/^([a-z]+)(\([^)]*\))?!?:\s*\S/i);
  if (m && PREFIX[m[1].toLowerCase()]) return PREFIX[m[1].toLowerCase()];
  if (/^Merge (pull request|branch|remote-tracking branch|tag)\b/i.test(s) || /^Merge '.*' into /i.test(s)) return 'chore';
  // "[fix] …", "Fix: …", "fix - …" all start with the type word.
  const word = s.replace(/^\[([^\]]+)\]\s*/, '$1 ').match(/^[a-z]+/i)?.[0].toLowerCase() ?? '';
  for (const [re, type] of FIRST_WORD) if (re.test(word)) return type;
  return 'other';
}
