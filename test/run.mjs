// Fast unit tests for the webview's pure logic (parser, serializer,
// list-DOM normalizer). Runs in Node + jsdom — no browser required.
//
// What this catches: regressions in markdownToHtml, htmlToMarkdown, and
// normalizeListDom. The serializer is fed both well-formed and known
// browser-quirky HTML so we cover the shapes Chromium produces from
// execCommand('indent'/'outdent') without launching a browser.
//
// What this doesn't catch: changes to how a real browser implements
// execCommand. Run `npm run test:e2e` (Playwright) for that.

import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

const harnessHtml = readFileSync(join(__dirname, 'harness.html'), 'utf8')
    .replace('<script src="editor.js"></script>', '');
const editorSrc = readFileSync(join(repoRoot, 'media', 'editor.js'), 'utf8');
const expose = '    window.__test = { markdownToHtml, htmlToMarkdown, normalizeListDom, extractFrontMatter };\n';
const patched = editorSrc.replace(/}\)\(\);\s*$/, expose + '})();\n');
if (patched === editorSrc) {
    console.error('Failed to inject test exposure into editor.js (IIFE pattern not found).');
    process.exit(1);
}

const dom = new JSDOM(harnessHtml, { runScripts: 'dangerously' });
const { window } = dom;
window.eval(patched);
const { markdownToHtml, htmlToMarkdown, normalizeListDom, extractFrontMatter } = window.__test;
const { document } = window;

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (!ok && detail ? ' :: ' + detail : ''));
}

function serialize(html) {
    const ed = document.getElementById('editor');
    ed.innerHTML = html;
    const snapshot = ed.cloneNode(true);
    normalizeListDom(snapshot);
    return htmlToMarkdown(snapshot).replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
const roundTrip = (md) => serialize(markdownToHtml(md));

// Parser: markdown → HTML
check(
    'parse: nested ul',
    /<ul><li>a<ul><li>b<\/li><li>c<\/li><\/ul><\/li><li>d<\/li><\/ul>/.test(
        markdownToHtml('- a\n  - b\n  - c\n- d\n')
    )
);
check(
    'parse: ol nested in ul',
    /<ul><li>top<ol><li>one<\/li><li>two<\/li><\/ol><\/li><li>next<\/li><\/ul>/.test(
        markdownToHtml('- top\n  1. one\n  2. two\n- next\n')
    )
);
check(
    'parse: 3-level nesting',
    /<ul><li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li><\/ul>/.test(
        markdownToHtml('- a\n  - b\n    - c\n')
    )
);
check(
    'parse: ul nested in ol (3-space indent)',
    /<ol><li>one<ul><li>sub<\/li><\/ul><\/li><li>two<\/li><\/ol>/.test(
        markdownToHtml('1. one\n   - sub\n2. two\n')
    )
);
check(
    'parse: tabs as indent',
    /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/.test(markdownToHtml('- a\n\t- b\n'))
);

// Serializer: round-trip md → HTML → md
{
    const out = roundTrip('- a\n  - b\n  - c\n- d\n');
    check('round-trip: nested ul', out.trim() === '- a\n  - b\n  - c\n- d', out);
}
{
    const out = roundTrip('- top\n  1. one\n  2. two\n- next\n');
    check('round-trip: ol nested in ul', out.trim() === '- top\n  1. one\n  2. two\n- next', out);
}
{
    const out = roundTrip('- a\n  - b\n    - c\n');
    check('round-trip: 3-level nesting', out.trim() === '- a\n  - b\n    - c', out);
}

// Quirky DOM shapes from browser execCommand calls
{
    // Chromium's execCommand('indent') shape: orphan <ul> sibling of <li>
    const out = serialize('<ul><li>item one</li><ul><li>item two</li></ul></ul>');
    check(
        'normalize: lifts orphan UL into preceding LI',
        out.includes('- item one') && out.includes('  - item two'),
        out
    );
}
{
    // Chromium's execCommand('outdent') shape: nested <li> inside <li>
    const out = serialize('<ul><li>a<li>b</li></li></ul>');
    check(
        'normalize: lifts nested LI out as sibling',
        /- a\n- b/.test(out) && !/- ab/.test(out),
        out
    );
}
{
    // Both quirks combined
    const out = serialize('<ul><li>a<li>b</li><ul><li>c</li></ul></li></ul>');
    check(
        'normalize: handles combined quirks',
        out.includes('- a') && out.includes('- b') && out.includes('  - c'),
        out
    );
}

// Round-trip preserves task list state inside nested lists
{
    const out = roundTrip('- a\n  - [x] done\n  - [ ] todo\n');
    check(
        'round-trip: task items inside nested list',
        out.includes('- a') && /  - \[x\] +done/.test(out) && /  - \[ \] +todo/.test(out),
        out
    );
}

// Mermaid: parser emits a placeholder div with the source preserved
{
    const html = markdownToHtml('```mermaid\ngraph TD\nA-->B\n```\n');
    check(
        'parse: mermaid block becomes placeholder div',
        /<div class="mermaid-block"[^>]*data-source="graph%20TD%0AA--%3EB"[^>]*>/.test(html),
        html
    );
}
{
    // Round-trip: rendered placeholder serializes back to the fenced source
    const out = serialize('<div class="mermaid-block" data-source="graph%20TD%0AA--%3EB"></div>');
    check(
        'round-trip: mermaid placeholder → fenced code',
        out.trim() === '```mermaid\ngraph TD\nA-->B\n```',
        out
    );
}
{
    // Non-mermaid fenced blocks still go through the normal path
    const html = markdownToHtml('```js\nconst x = 1;\n```\n');
    check(
        'parse: non-mermaid fenced block unchanged',
        /<pre><code class="language-js">const x = 1;<\/code><\/pre>/.test(html),
        html
    );
}

// Front matter: extractFrontMatter splits the leading YAML block
{
    const r = extractFrontMatter('---\ntitle: Hello\ntags: [a, b]\n---\n# Body\n');
    check(
        'front matter: extracted and stripped from body',
        r.frontMatter === '---\ntitle: Hello\ntags: [a, b]\n---\n' && r.body === '# Body\n',
        JSON.stringify(r)
    );
}
{
    const r = extractFrontMatter('# No front matter\n');
    check(
        'front matter: passthrough when absent',
        r.frontMatter === '' && r.body === '# No front matter\n',
        JSON.stringify(r)
    );
}
{
    // A leading `---` that is actually a horizontal rule (no closing fence) is not front matter
    const r = extractFrontMatter('---\nnot front matter\n# Body\n');
    check(
        'front matter: leading --- without closing fence is not extracted',
        r.frontMatter === '' && r.body === '---\nnot front matter\n# Body\n',
        JSON.stringify(r)
    );
}
{
    // The body that follows is parsed normally and front matter does not leak into the HTML
    const r = extractFrontMatter('---\nfoo: bar\n---\n# Body\n');
    const html = markdownToHtml(r.body);
    check(
        'front matter: not rendered in HTML',
        !html.includes('foo: bar') && /<h1>Body<\/h1>/.test(html),
        html
    );
}

const failed = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
