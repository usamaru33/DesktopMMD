// README.md → build/README.html (styled, self-contained) for the installer.
import fs from 'node:fs';
import { marked } from 'marked';

const md = fs.readFileSync('README.md', 'utf8')
  // the developer guide isn't shipped; drop the pointer to it
  .replace(/^> 開発者向けの情報は.*$/m, '');
// the installer's README.html is a single file: inline the images it points to
let body = (marked.parse(md, { gfm: true })).replace(/<img src="(docs\/images\/[^"]+\.(jpg|png))"/g, (_, src, ext) =>
  `<img src="data:image/${ext === 'jpg' ? 'jpeg' : 'png'};base64,${fs.readFileSync(src).toString('base64')}"`);
// headings get the same ids GitHub gives them, so the README's in-page links work in the HTML too
const slug = (t) => t.replace(/<[^>]+>/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
const ids = new Set();
body = body.replace(/<h([1-6])>(.*?)<\/h\1>/g, (_, n, inner) => {
  const id = slug(inner);
  ids.add(id);
  return `<h${n} id="${id}">${inner}</h${n}>`;
});
const broken = [...body.matchAll(/href="#([^"]+)"/g)].map((m) => decodeURIComponent(m[1])).filter((id) => !ids.has(id));
if (broken.length) throw new Error(`README.md: links to missing headings: ${broken.join(', ')}`);

const html = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DesktopMMD の使い方</title>
<style>
:root{--ink:#2b2733;--soft:#6b6575;--line:#e7e3ea;--accent:#d9608a;--bg:#f6f5f2;--panel:#fff}
@media (prefers-color-scheme:dark){:root{--ink:#ece9f1;--soft:#b5aec0;--line:#3a3642;--accent:#f07fa6;--bg:#1c1a21;--panel:#26232c}}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.75 'BIZ UDPGothic','Yu Gothic UI','Meiryo UI',sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 24px 80px;background:var(--panel);min-height:100vh}
h1{color:var(--accent);margin-top:0}h2{border-bottom:2px solid var(--line);padding-bottom:4px;margin-top:2.2em}
table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid var(--line);padding:6px 10px;text-align:left;vertical-align:top}
th{background:var(--bg)}code{background:var(--bg);padding:1px 5px;border-radius:4px}a{color:var(--accent)}
img{max-width:100%;height:auto;border-radius:6px}blockquote{margin:12px 0;padding:8px 14px;border-left:4px solid var(--accent);background:var(--bg);color:var(--soft)}
</style></head><body><main>${body}</main></body></html>`;
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/README.html', html);
console.log('wrote build/README.html');
