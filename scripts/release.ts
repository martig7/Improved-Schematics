// Generate a release-notes DRAFT from the git log since the last tag, grouped by
// conventional-commit type, into docs/releases/v<version>-draft.md to edit.
//
// Usage: npx tsx scripts/release.ts <version>      e.g. npx tsx scripts/release.ts 2.1.0
//
// This ONLY writes a scratch draft. It does not tag, bump the version, or publish.
// The release itself is driven by .github/workflows/release.yml, which fires on a
// pushed vX.Y.Z tag and uses the ANNOTATED TAG MESSAGE BODY as the GitHub Release
// notes. So the release flow is:
//   1. run this, then edit docs/releases/v<version>-draft.md into the final notes
//   2. bump MOD_VERSION in src/version.ts, run `pnpm build` (which syncs the value
//      into package.json + manifest.json), and commit  (the workflow verifies the
//      tag matches those two versions)
//   3. `git tag -a v<version> --cleanup=verbatim -F docs/releases/v<version>-draft.md`
//      (--cleanup=verbatim is REQUIRED: the default strips the markdown "#" headers
//      as git comments. The notes' first "# v<version>" line is the tag subject and
//      is dropped from the release body.)
//   4. `git push origin v<version>`  ->  the workflow builds, zips, and publishes
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('usage: tsx scripts/release.ts <version>   (e.g. 2.1.0)');
  process.exit(1);
}

const sh = (cmd: string): string => execSync(cmd, { encoding: 'utf8' }).trim();
const lastTag = sh('git describe --tags --abbrev=0');
const log = sh(`git log ${lastTag}..HEAD --no-merges --format=%s`);
const commits = log ? log.split('\n') : [];
const date = sh('git log -1 --format=%cs');

// Group by conventional-commit type (feat, fix, ...); non-conventional -> 'other'.
const typeOf = (s: string): string => (s.match(/^([a-z]+)(\([^)]*\))?!?:/i)?.[1]?.toLowerCase() ?? 'other');
const strip = (s: string): string => s.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
const groups: Record<string, string[]> = {};
for (const s of commits) (groups[typeOf(s)] ??= []).push(strip(s));

const TITLE: Record<string, string> = {
  feat: 'Features', fix: 'Fixes', ui: 'UI', tune: 'Tuning', perf: 'Performance',
  refactor: 'Under the hood', chore: 'Chores', test: 'Tests', docs: 'Docs',
  experiment: 'Experiments', revert: 'Reverts', polish: 'Polish', other: 'Other',
};
const USER_FACING = ['feat', 'fix', 'ui', 'tune', 'perf'];
const INTERNAL = ['refactor', 'chore', 'test', 'docs', 'experiment', 'revert', 'polish', 'other'];

const out: string[] = [];
out.push(`# v${version}`, '', `_Draft, ${date}. ${commits.length} commits since ${lastTag}._`, '');
out.push('## Highlights', '', '- TODO: a few sentences on the headline changes for players', '');
const section = (keys: string[], heading: string): void => {
  const present = keys.filter((k) => groups[k]?.length);
  if (!present.length) return;
  out.push(`## ${heading}`, '');
  for (const k of present) {
    out.push(`### ${TITLE[k] ?? k}`, '');
    for (const s of groups[k]) out.push(`- ${s}`);
    out.push('');
  }
};
section(USER_FACING, "What's new");
section(INTERNAL, 'Internal / maintenance');

const dir = 'docs/releases';
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const path = `${dir}/v${version}-draft.md`;
writeFileSync(path, out.join('\n'));
console.log(`wrote ${path} — ${commits.length} commits since ${lastTag}`);
