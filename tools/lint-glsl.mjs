/**
 * Guards against a failure mode that bit this codebase repeatedly and fails in
 * a badly misleading way: a backtick inside a comment that sits inside a GLSL
 * template literal.
 *
 * `const s = /* glsl *\/` ... // uses `foo` ... `;`
 *
 * The backtick in the comment terminates the template string, so the rest of
 * the shader is parsed as TypeScript. The reported error lands dozens of lines
 * away from the real cause and reads as a stray comma.
 *
 * Rather than trusting everyone to remember, we detect it mechanically: any
 * backtick inside a `//` or block comment in a .ts file is a hard error.
 *
 * Usage: node tools/lint-glsl.mjs [--fix]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const FIX = process.argv.includes('--fix');

const files = execSync('find src server tools -name "*.ts" 2>/dev/null || true')
  .toString().trim().split('\n').filter(Boolean);

let problems = 0;
let fixed = 0;

for (const file of files) {
  const original = readFileSync(file, 'utf8');
  let text = original;

  // Block comments.
  text = text.replace(/\/\*[\s\S]*?\*\//g, (m, offset) => {
    if (!m.includes('`')) return m;
    const line = original.slice(0, offset).split('\n').length;
    problems++;
    if (!FIX) console.error(`${file}:${line}  backtick inside block comment`);
    return m.replace(/`/g, "'");
  });

  // Line comments. Skip lines where the `//` is itself inside a string, which
  // is common in shader source ("https://..." in a citation) — a cheap but
  // effective heuristic is to require the // to be the first non-space token.
  text = text.split('\n').map((ln, i) => {
    const m = ln.match(/^(\s*)\/\/(.*)$/);
    if (!m || !m[2].includes('`')) return ln;
    problems++;
    if (!FIX) console.error(`${file}:${i + 1}  backtick inside line comment`);
    return `${m[1]}//${m[2].replace(/`/g, "'")}`;
  }).join('\n');

  if (FIX && text !== original) {
    writeFileSync(file, text);
    fixed++;
  }
}

if (FIX) {
  console.log(`glsl-lint: normalised ${fixed} file(s), ${problems} occurrence(s)`);
  process.exit(0);
}

if (problems) {
  console.error(`\nglsl-lint: ${problems} backtick(s) inside comments.`);
  console.error('These silently terminate any enclosing GLSL template literal.');
  console.error('Run: node tools/lint-glsl.mjs --fix');
  process.exit(1);
}
console.log(`glsl-lint: clean (${files.length} files)`);
