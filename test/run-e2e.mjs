// End-to-end tests for the webview editor (Chromium via Playwright).
//
// This suite verifies real browser behavior — specifically that
// document.execCommand('indent'/'outdent') still emits the quirky DOM
// shapes that normalizeListDom corrects. It's complementary to the jsdom
// suite in run.mjs and is intended for manual / nightly runs, not every
// PR. Requires `npx playwright install chromium` once.

import { chromium } from 'playwright-core';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');

// Stage harness + editor.js in a temp dir so the harness's relative
// `<script src="editor.js">` resolves alongside the patched copy.
const stage = mkdtempSync(join(tmpdir(), 'clearview-test-'));
copyFileSync(join(__dirname, 'harness.html'), join(stage, 'harness.html'));

const editorSrc = readFileSync(join(repoRoot, 'media', 'editor.js'), 'utf8');
const expose = '    window.__test = { markdownToHtml, htmlToMarkdown, normalizeListDom };\n';
const patched = editorSrc.replace(/}\)\(\);\s*$/, expose + '})();\n');
if (patched === editorSrc) {
    console.error('Failed to inject test exposure into editor.js (IIFE pattern not found).');
    process.exit(1);
}
writeFileSync(join(stage, 'editor.js'), patched);

const results = [];
function check(name, ok, detail) {
    results.push({ name, ok });
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + name + (!ok && detail ? ' :: ' + detail : ''));
}

const browser = await chromium.launch();
try {
    const page = await browser.newContext().then(c => c.newPage());
    page.on('pageerror', err => console.log('[pageerror]', err.message));

    await page.goto(pathToFileURL(join(stage, 'harness.html')).href);
    await page.waitForFunction(() => window.__test);

    const parse = (md) => page.evaluate(m => window.__test.markdownToHtml(m), md);
    const serialize = (html) => page.evaluate(h => {
        const ed = document.getElementById('editor');
        ed.innerHTML = h;
        return window.__test.htmlToMarkdown(ed).replace(/\n{3,}/g, '\n\n').trim() + '\n';
    }, html);
    const roundTrip = async (md) => serialize(await parse(md));
    const serializeLive = () => page.evaluate(() => {
        const c = document.getElementById('editor').cloneNode(true);
        window.__test.normalizeListDom(c);
        return window.__test.htmlToMarkdown(c).trim();
    });
    const placeCursor = (html, liIndex) => page.evaluate(({ html, idx }) => {
        const ed = document.getElementById('editor');
        ed.innerHTML = html;
        const target = ed.querySelectorAll('li')[idx];
        const range = document.createRange();
        range.setStart(target.firstChild, 0);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ed.focus();
    }, { html, idx: liIndex });

    // Parser: markdown → HTML
    check(
        'parse: nested ul',
        /<ul><li>a<ul><li>b<\/li><li>c<\/li><\/ul><\/li><li>d<\/li><\/ul>/.test(
            await parse('- a\n  - b\n  - c\n- d\n')
        )
    );
    check(
        'parse: ol nested in ul',
        /<ul><li>top<ol><li>one<\/li><li>two<\/li><\/ol><\/li><li>next<\/li><\/ul>/.test(
            await parse('- top\n  1. one\n  2. two\n- next\n')
        )
    );
    check(
        'parse: 3-level nesting',
        /<ul><li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li><\/ul>/.test(
            await parse('- a\n  - b\n    - c\n')
        )
    );
    check(
        'parse: ul nested in ol (3-space indent)',
        /<ol><li>one<ul><li>sub<\/li><\/ul><\/li><li>two<\/li><\/ol>/.test(
            await parse('1. one\n   - sub\n2. two\n')
        )
    );

    // Serializer: round-trip md → HTML → md
    {
        const out = await roundTrip('- a\n  - b\n  - c\n- d\n');
        check('round-trip: nested ul', out.trim() === '- a\n  - b\n  - c\n- d', out);
    }
    {
        const out = await roundTrip('- top\n  1. one\n  2. two\n- next\n');
        check('round-trip: ol nested in ul', out.trim() === '- top\n  1. one\n  2. two\n- next', out);
    }
    {
        const out = await roundTrip('- a\n  - b\n    - c\n');
        check('round-trip: 3-level nesting', out.trim() === '- a\n  - b\n    - c', out);
    }

    // Serializer tolerates Chromium's UL>UL output from execCommand('indent')
    {
        const out = await serialize('<ul><li>item one</li><ul><li>item two</li></ul></ul>');
        check(
            'serialize: tolerates UL>UL quirk',
            out.includes('- item one') && out.includes('  - item two'),
            out
        );
    }

    // Tab indents a list item
    await placeCursor('<ul><li>item one</li><li>item two</li></ul>', 1);
    await page.keyboard.press('Tab');
    {
        const out = await serializeLive();
        check(
            'Tab: indents second list item',
            out.includes('- item one') && /  - item two/.test(out),
            out
        );
    }

    // Shift+Tab outdents a nested item
    await placeCursor('<ul><li>a<ul><li>b</li></ul></li></ul>', 1);
    await page.keyboard.press('Shift+Tab');
    {
        const out = await serializeLive();
        check(
            'Shift+Tab: outdents nested item',
            /- a/.test(out) && /- b/.test(out) && !/  - b/.test(out),
            out
        );
    }

    // Toolbar Indent button
    await placeCursor('<ul><li>alpha</li><li>beta</li></ul>', 1);
    await page.click('#btnIndent');
    {
        const out = await serializeLive();
        check(
            'Toolbar Indent button',
            out.includes('- alpha') && /  - beta/.test(out),
            out
        );
    }

    // Toolbar Outdent button
    await placeCursor('<ul><li>x<ul><li>y</li></ul></li></ul>', 1);
    await page.click('#btnOutdent');
    {
        const out = await serializeLive();
        check(
            'Toolbar Outdent button',
            /- x/.test(out) && /- y/.test(out) && !/  - y/.test(out),
            out
        );
    }

    // Tab in code blocks still inserts spaces (regression check)
    await page.evaluate(() => {
        const ed = document.getElementById('editor');
        ed.innerHTML = '<pre><code>line1\n</code></pre>';
        const code = ed.querySelector('code');
        const range = document.createRange();
        range.setStart(code.firstChild, code.firstChild.textContent.length);
        range.collapse(true);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ed.focus();
    });
    await page.keyboard.press('Tab');
    {
        const text = await page.evaluate(() => document.getElementById('editor').textContent);
        check('Tab in code block inserts spaces (regression)', text.includes('    '), text);
    }
} finally {
    await browser.close();
    rmSync(stage, { recursive: true, force: true });
}

const failed = results.filter(r => !r.ok).length;
console.log('\n' + (results.length - failed) + '/' + results.length + ' passed');
process.exit(failed ? 1 : 0);
