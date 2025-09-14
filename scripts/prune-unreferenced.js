const fs = require('fs');
const path = require('path');

function walk(dir, filter = () => true, out = []) {
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

function isLocal(url) {
  return !/^(https?:)?\/\//i.test(url) && !/^(mailto:|tel:|javascript:|data:)/i.test(url);
}

function resolveRef(fromFile, ref) {
  const clean = ref.split('#')[0];
  const fromDir = path.dirname(fromFile);
  // decode per segment but preserve %2F
  const relDecoded = clean.split('/').map(seg => {
    try { return decodeURIComponent(seg.replace(/%2F/gi, '%252F')); } catch { return seg; }
  }).join(path.sep);
  return path.normalize(path.join(fromDir, relDecoded));
}

function collectReferences(root) {
  const htmlFiles = walk(root, p => p.toLowerCase().endsWith('.html'));
  const cssFiles = walk(root, p => p.toLowerCase().endsWith('.css'));
  const refs = new Set();

  const attrRe = /(href|src)=("|')([^"']+)\2/gi;
  for (const file of htmlFiles) {
    const html = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = attrRe.exec(html))) {
      const url = m[3];
      if (!isLocal(url)) continue;
      const abs = resolveRef(file, url);
      refs.add(path.resolve(abs));
    }
  }

  const urlRe = /url\(([^)]+)\)/gi;
  for (const file of cssFiles) {
    const css = fs.readFileSync(file, 'utf8');
    let m;
    while ((m = urlRe.exec(css))) {
      let raw = m[1].trim().replace(/^['"]|['"]$/g, '');
      if (!isLocal(raw)) continue;
      const abs = resolveRef(file, raw);
      refs.add(path.resolve(abs));
    }
  }
  return refs;
}

function main() {
  const apply = process.argv.includes('--apply');
  const root = process.cwd();
  const allFiles = walk(root, p => /(^|\\|\/)[^\\\/]+_files(\\|\/)/.test(p));
  const refs = collectReferences(root);

  const unref = [];
  for (const file of allFiles) {
    const abs = path.resolve(file);
    if (!refs.has(abs)) unref.push(file);
  }

  console.log(`Found ${allFiles.length} files under *_files folders.`);
  console.log(`Referenced: ${allFiles.length - unref.length}. Unreferenced: ${unref.length}.`);
  if (!unref.length) return;

  if (!apply) {
    console.log('Dry run (no deletions). Pass --apply to delete. Sample:');
    for (const f of unref.slice(0, 20)) console.log(' -', f);
    return;
  }

  let deleted = 0;
  for (const f of unref) {
    try { fs.unlinkSync(f); deleted++; }
    catch (e) { console.warn('Failed to delete', f, e.message); }
  }
  console.log(`Deleted ${deleted} unreferenced files.`);
}

main();
