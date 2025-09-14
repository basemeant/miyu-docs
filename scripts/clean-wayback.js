const fs = require('fs');
const path = require('path');

// Utility: walk all files in a directory tree
function walk(dir, filterFn = () => true, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, filterFn, out);
    else if (filterFn(p)) out.push(p);
  }
  return out;
}

// Build a mapping from original help.yuibot.app path -> local file path
function buildMapping(rootDir, htmlFiles) {
  const map = new Map();
  for (const file of htmlFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/<!--\s*saved from url=\(\d+\).*?(https?:\/\/help\.yuibot\.app\/[^^\s>]*?)\s*-->/i);
    if (!m) continue;
    let urlStr = m[1];
    try {
      const u = new URL(urlStr);
      let key = u.pathname || '/';
      // Normalize: remove trailing slash except for root
      if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
      // Store path relative to root, with posix separators
      const rel = path.relative(rootDir, file).split(path.sep).join('/');
      map.set(key.toLowerCase(), rel);
    } catch (e) {
      // ignore parse errors
    }
  }
  return map;
}

// Encode each path segment but keep slashes
function encodePathForHref(p) {
  return p.split('/').map(seg => encodeURIComponent(seg)).join('/');
}

// Compute relative href from fromFile to target local file path
function relativeHref(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const rel = path.posix.relative(fromDir.split(path.sep).join('/'), toFile);
  return encodePathForHref(rel);
}

function removeWaybackHeadInjections(html) {
  // Remove the top injection block between athena.js and End Wayback comment
  html = html.replace(/<script[^>]+athena\.js[^>]*>[\s\S]*?<!--\s*End Wayback Rewrite JS Include\s*-->\s*/i, '');
  // Remove leftover specific assets if present
  html = html
    .replace(/<link[^>]+banner-styles\.css[^>]*>\s*/gi, '')
    .replace(/<link[^>]+iconochive\.css[^>]*>\s*/gi, '')
    .replace(/<script[^>]+bundle-playback\.js[^>]*><\/script>\s*/gi, '')
    .replace(/<script[^>]+wombat\.js[^>]*><\/script>\s*/gi, '')
    .replace(/<script[^>]+ruffle\.js[^>]*><\/script>\s*/gi, '')
    .replace(/<script[^>]+athena\.js[^>]*><\/script>\s*/gi, '')
    .replace(/<script[^>]*>[^<]*__wm\.(init|wombat)[\s\S]*?<\/script>\s*/gi, '');
  // Remove saved-from comment
  html = html.replace(/<!--\s*saved from url=\(\d+\).*?-->\s*/i, '');
  // Remove wm-toolbar height style on <html>
  html = html.replace(/(<html\b[^>]*?)\sstyle=\"[^\"]*--wm-toolbar-height:[^\"]*\"/i, '$1');
  return html;
}

function removeWaybackToolbar(html) {
  // Variant 1: toolbar div structure
  const startIdx = html.indexOf('id="wm-ipp-base"');
  if (startIdx !== -1) {
    const openTagStart = html.lastIndexOf('<div', startIdx);
    if (openTagStart !== -1) {
      const printIdx = html.indexOf('id="wm-ipp-print"', startIdx);
      if (printIdx !== -1) {
        // Heuristic: close after the next </div> following the print element
        const closeAfterPrint = html.indexOf('</div>', printIdx);
        if (closeAfterPrint !== -1) {
          const end = closeAfterPrint + '</div>'.length;
          html = html.slice(0, openTagStart) + html.slice(end);
        }
      }
    }
  }
  // Variant 2: explicit comment-delimited block
  html = html.replace(/<!--\s*BEGIN WAYBACK TOOLBAR INSERT\s*-->[\s\S]*?<!--\s*END WAYBACK TOOLBAR INSERT\s*-->\s*/i, '');
  // Remove any lingering calls to __wm.* APIs if present
  html = html.replace(/<script[^>]*>[\s\S]*?__wm\.[^<]*<\/script>\s*/gi, '');
  return html;
}

function rewriteLinks(html, fromFilePosix, map) {
  // Replace absolute help.yuibot.app links, possibly prefixed by web.archive.org
  const re = /(href|src)=("|')(?:(?:https?:\/\/web\.archive\.org\/web\/\d+\/)?https?:\/\/help\.yuibot\.app)?(\/[^"'>]*)\2/gi;
  html = html.replace(re, (m, attr, quote, pathPart) => {
    if (!pathPart) return m;
    // Ignore anchors only
    if (pathPart.startsWith('#')) return m;
    // Normalize and lookup
    let key = pathPart;
    try {
      const u = new URL('https://help.yuibot.app' + pathPart);
      key = u.pathname || '/';
    } catch (_) {}
    // Remove trailing slash except root
    if (key.length > 1 && key.endsWith('/')) key = key.slice(0, -1);
    const target = map.get(key.toLowerCase());
    if (!target) {
      // Also try without decoding and with decoding
      const alt = decodeURIComponent(key);
      const targetAlt = map.get(alt.toLowerCase());
      if (!targetAlt) return m; // leave as-is
      const rel = relativeHref(fromFilePosix, targetAlt);
      return `${attr}=${quote}${rel}${quote}`;
    }
    const rel = relativeHref(fromFilePosix, target);
    return `${attr}=${quote}${rel}${quote}`;
  });
  // Strip generic web.archive.org prefix for any remaining absolute links
  html = html.replace(/(href|src)=("|')https?:\/\/web\.archive\.org\/web\/\d+\/(https?:\/\/[^"'>]+)\2/gi, (m, attr, quote, orig) => {
    return `${attr}=${quote}${orig}${quote}`;
  });
  // Strip image/asset rewrite form with "im_" segment
  html = html.replace(/https?:\/\/web\.archive\.org\/web\/\d+im_\/(https?:\/\/[^"')\s>]+)/gi, (m, orig) => orig);
  return html;
}

function main() {
  const rootDir = process.cwd();
  const htmlFiles = walk(rootDir, p => p.toLowerCase().endsWith('.html'));
  if (htmlFiles.length === 0) {
    console.error('No HTML files found.');
    process.exit(1);
  }
  // Build mapping from saved-from URL
  const map = buildMapping(rootDir, htmlFiles);
  if (map.size === 0) {
    console.error('No mapping could be built from saved-from comments.');
  }

  let changedCount = 0;
  for (const file of htmlFiles) {
    const raw = fs.readFileSync(file, 'utf8');
    let html = raw;
    html = removeWaybackHeadInjections(html);
    html = removeWaybackToolbar(html);
    const fromPosix = path.relative(rootDir, file).split(path.sep).join('/');
    html = rewriteLinks(html, fromPosix, map);

    if (html !== raw) {
      fs.writeFileSync(file, html, 'utf8');
      changedCount++;
    }
  }
  console.log(`Processed ${htmlFiles.length} HTML files. Modified ${changedCount}.`);
}

if (require.main === module) {
  main();
}
