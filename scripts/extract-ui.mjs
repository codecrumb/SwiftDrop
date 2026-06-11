import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { getHTML, getHelpPage, getManifest, getServiceWorker } =
  await import(pathToFileURL(join(root, 'worker.js')));

// Empty env => data-sitekey="" — matches a local baseline with no TURNSTILE_SITE_ID set.
const html = getHTML({});

const styleOpen = html.indexOf('<style>');
const styleClose = html.indexOf('</style>');
const scriptOpen = html.indexOf('<script>'); // exactly one bare <script>; CDN tags use <script src=
const scriptClose = html.lastIndexOf('</script>');
if ([styleOpen, styleClose, scriptOpen, scriptClose].some((i) => i === -1)) {
  throw new Error('marker not found');
}
if (html.indexOf('<style>', styleOpen + 1) !== -1) throw new Error('more than one <style> block');
if (html.indexOf('<script>', scriptOpen + 1) !== -1) throw new Error('more than one bare <script> block');

const css = html.slice(styleOpen + '<style>'.length, styleClose);
const js = html.slice(scriptOpen + '<script>'.length, scriptClose);

const indexHtml =
  html.slice(0, styleOpen) +
  '<link rel="stylesheet" href="/styles.css">' +
  html.slice(styleClose + '</style>'.length, scriptOpen) +
  '<script src="/app.js"></script>' +
  html.slice(scriptClose + '</script>'.length);

// Verify the split is lossless: reassembling must reproduce getHTML({}) byte-for-byte.
const reassembled = indexHtml
  .replace('<link rel="stylesheet" href="/styles.css">', '<style>' + css + '</style>')
  .replace('<script src="/app.js"></script>', '<script>' + js + '</script>');
if (reassembled !== html) throw new Error('reassembly mismatch — split is lossy');

mkdirSync(join(root, 'public', 'help'), { recursive: true });
writeFileSync(join(root, 'public', 'index.html'), indexHtml);
writeFileSync(join(root, 'public', 'styles.css'), css.trim() + '\n');
writeFileSync(join(root, 'public', 'app.js'), js.trim() + '\n');
writeFileSync(join(root, 'public', 'sw.js'), getServiceWorker());
writeFileSync(join(root, 'public', 'manifest.webmanifest'), getManifest());
writeFileSync(join(root, 'public', 'help', 'popups.html'), getHelpPage());
console.log('extracted OK');
