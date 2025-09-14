const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  const ents = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.toLowerCase().endsWith('.html')) out.push(p);
  }
  return out;
}

function main() {
  const root = process.cwd();
  const files = walk(root);
  const broken = [];
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const re = /(href|src)=("|')([^"']+)\2/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = m[3];
      // Skip external, anchors, protocols
      if (/^(https?:)?\/\//i.test(url)) continue;
      if (/^(mailto:|tel:|javascript:|data:)/i.test(url)) continue;
      if (url.startsWith('#')) continue;
      // Strip query/hash and only verify .html targets
      const clean = url.split('#')[0].split('?')[0];
      if (!/\.html$/i.test(clean)) continue;
      if (!clean) continue;
      // Resolve relative to file dir
      const fromDir = path.dirname(file);
      // Decode per segment, but keep %2F as literal
      const relDecoded = clean.split('/').map(s => {
        try {
          const preserved = s.replace(/%2F/gi, '%252F');
          return decodeURIComponent(preserved);
        } catch { return s; }
      }).join(path.sep);
      const candidate = path.normalize(path.join(fromDir, relDecoded));
      if (!fs.existsSync(candidate)) {
        broken.push({ file: path.relative(root, file), ref: url, resolved: path.relative(root, candidate) });
      }
    }
  }
  if (broken.length) {
    console.log(`Broken local links found: ${broken.length}`);
    for (const b of broken) {
      console.log(` - ${b.file} -> ${b.ref} (resolved: ${b.resolved})`);
    }
    process.exitCode = 1;
  } else {
    console.log('No broken local links detected.');
  }
}

main();
