import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[jt]sx$/.test(path) ? [path] : [];
  });
}

test('site links navigate on intent without speculative route/data fan-out', () => {
  const failures = [];
  let links = 0;
  for (const path of sourceFiles('src')) {
    const text = readFileSync(path, 'utf8');
    if (!/import Link from ["']next\/link["']/.test(text)) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node) {
      if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(source) === 'Link') {
        links++;
        const prefetch = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(source) === 'prefetch');
        if (prefetch?.initializer?.getText(source) !== '{false}') failures.push(`${path}:${source.getLineAndCharacterOfPosition(node.pos).line + 1}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert.ok(links > 100, 'cover the complete site, not a single navigation component');
  assert.deepEqual(failures, []);
  assert.doesNotMatch(readFileSync('src/components/GlobalSearchBar.jsx', 'utf8'), /router\.prefetch\(/,
    'search highlighting must not render unselected research destinations');
});
