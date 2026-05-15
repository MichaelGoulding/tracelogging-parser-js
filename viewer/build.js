#!/usr/bin/env node
/**
 * Build script for the self-contained ETL viewer HTML file.
 *
 * Reads the source JS modules (src/*.js), strips Node.js require/exports,
 * and injects them into viewer/template.html at the BUILD:INLINE_JS marker.
 *
 * Usage:  node viewer/build.js
 * Output: etl-viewer.html (root of repo)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(__dirname, 'template.html');
const OUTPUT = path.join(ROOT, 'etl-viewer.html');

// Source files in dependency order (no circular deps)
const SOURCE_FILES = [
  'src/binary-reader.js',
  'src/errors.js',
  'src/wmi.js',
  'src/records.js',
  'src/tracelogging.js',
  'src/xpress.js',
  'src/etl-parser.js',
];

function stripNodeWrapper(source, filename) {
  // Remove multiline module.exports = { ... }; blocks
  let code = source.replace(/module\.exports\s*=\s*\{[^}]*\};?\s*/gs, '');
  // Remove require() lines
  const lines = code.split('\n');
  const filtered = lines.filter(line => {
    const trimmed = line.trim();
    if (/^const\s+.*=\s*require\s*\(/.test(trimmed)) return false;
    if (/^const\s*\{.*\}\s*=\s*require\s*\(/.test(trimmed)) return false;
    return true;
  });
  code = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `// --- ${filename} ---\n${code}`;
}

// Read template
const template = fs.readFileSync(TEMPLATE, 'utf-8');
if (!template.includes('// BUILD:INLINE_JS')) {
  console.error('Error: template.html is missing the // BUILD:INLINE_JS marker');
  process.exit(1);
}

// Read and process each source file
const parts = SOURCE_FILES.map(relPath => {
  const fullPath = path.join(ROOT, relPath);
  const source = fs.readFileSync(fullPath, 'utf-8');
  return stripNodeWrapper(source, relPath);
});

const inlinedJs = parts.join('\n\n');

// Replace marker with inlined JS
const output = template.replace('// BUILD:INLINE_JS', inlinedJs);

fs.writeFileSync(OUTPUT, output, 'utf-8');
const sizeKB = (Buffer.byteLength(output) / 1024).toFixed(1);
console.log(`Built ${OUTPUT} (${sizeKB} KB)`);
