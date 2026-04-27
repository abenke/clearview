(function () {
    const vscode = acquireVsCodeApi();
    const editor = document.getElementById('editor');
    const status = document.getElementById('status');
    const blockType = document.getElementById('blockType');

    let saveTimeout = null;
    let ignoreNextInput = false;
    let savedRange = null;
    let isSaving = false; // flag to ignore watcher events triggered by our own saves

    function saveSelection() {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            savedRange = sel.getRangeAt(0).cloneRange();
        }
    }

    function restoreSelection() {
        if (savedRange) {
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(savedRange);
            savedRange = null;
        }
    }

    // ─── Markdown Parser (MD → HTML) ─────────────────────────
    function markdownToHtml(md) {
        let html = '';
        const lines = md.split('\n');
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];

            // Fenced code block
            if (/^```/.test(line)) {
                const lang = line.slice(3).trim();
                const codeLines = [];
                i++;
                while (i < lines.length && !/^```/.test(lines[i])) {
                    codeLines.push(escapeHtml(lines[i]));
                    i++;
                }
                i++; // skip closing
                html += '<pre><code' + (lang ? ' class="language-' + lang + '"' : '') + '>' + codeLines.join('\n') + '</code></pre>';
                continue;
            }

            // Headings
            const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
            if (headingMatch) {
                const level = headingMatch[1].length;
                html += '<h' + level + '>' + inlineMarkdown(headingMatch[2]) + '</h' + level + '>';
                i++;
                continue;
            }

            // Horizontal rule
            if (/^(---|\*\*\*|___)\s*$/.test(line)) {
                html += '<hr>';
                i++;
                continue;
            }

            // Blockquote
            if (/^>\s?/.test(line)) {
                const quoteLines = [];
                while (i < lines.length && /^>\s?/.test(lines[i])) {
                    quoteLines.push(lines[i].replace(/^>\s?/, ''));
                    i++;
                }
                html += '<blockquote>' + markdownToHtml(quoteLines.join('\n')) + '</blockquote>';
                continue;
            }

            // Unordered list
            if (/^\s*[-*+]\s/.test(line)) {
                const result = parseList(lines, i, 'ul');
                html += result.html;
                i = result.end;
                continue;
            }

            // Ordered list
            if (/^\s*\d+\.\s/.test(line)) {
                const result = parseList(lines, i, 'ol');
                html += result.html;
                i = result.end;
                continue;
            }

            // Table
            if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*[-:]+/.test(lines[i + 1])) {
                const result = parseTable(lines, i);
                html += result.html;
                i = result.end;
                continue;
            }

            // Empty line
            if (line.trim() === '') {
                i++;
                continue;
            }

            // Paragraph
            const paraLines = [];
            while (i < lines.length && lines[i].trim() !== '' &&
                !/^(#{1,6}\s|>|[-*+]\s|\d+\.\s|```|---|\*\*\*|___)/.test(lines[i]) &&
                !(lines[i].includes('|') && i + 1 < lines.length && lines[i + 1] && /^\s*\|?\s*[-:]+/.test(lines[i + 1]))) {
                paraLines.push(lines[i]);
                i++;
            }
            html += '<p>' + inlineMarkdown(paraLines.join(' ')) + '</p>';
        }

        return html;
    }

    function getIndentWidth(line) {
        const match = line.match(/^([ \t]*)/);
        if (!match) return 0;
        let width = 0;
        for (let k = 0; k < match[1].length; k++) {
            width += match[1][k] === '\t' ? 4 : 1;
        }
        return width;
    }

    function parseList(lines, start, tag) {
        const baseIndent = getIndentWidth(lines[start]);
        let html = '<' + tag + '>';
        let i = start;

        while (i < lines.length) {
            const line = lines[i];
            const ulMatch = line.match(/^\s*[-*+]\s(.*)/);
            const olMatch = line.match(/^\s*\d+\.\s(.*)/);
            const match = ulMatch || olMatch;
            if (!match) break;

            const indent = getIndentWidth(line);
            if (indent < baseIndent) break;

            if (indent > baseIndent) {
                const nestedTag = ulMatch ? 'ul' : 'ol';
                const nested = parseList(lines, i, nestedTag);
                html = html.replace(/<\/li>$/, nested.html + '</li>');
                i = nested.end;
                continue;
            }

            const lineTag = ulMatch ? 'ul' : 'ol';
            if (lineTag !== tag) break;

            const content = match[1];
            const taskMatch = content.match(/^\[([ xX])\]\s?(.*)/);
            if (taskMatch) {
                const checked = taskMatch[1] !== ' ' ? ' checked' : '';
                html += '<li><input type="checkbox"' + checked + '> ' + inlineMarkdown(taskMatch[2]) + '</li>';
            } else {
                html += '<li>' + inlineMarkdown(content) + '</li>';
            }
            i++;
        }

        html += '</' + tag + '>';
        return { html, end: i };
    }

    function parseTable(lines, start) {
        let html = '<table>';
        const headers = lines[start].split('|').filter(function (c) { return c.trim() !== ''; }).map(function (c) { return c.trim(); });

        html += '<thead><tr>';
        headers.forEach(function (h) { html += '<th>' + inlineMarkdown(h) + '</th>'; });
        html += '</tr></thead><tbody>';

        let i = start + 2; // skip header and separator
        while (i < lines.length && lines[i].includes('|')) {
            const cells = lines[i].split('|').filter(function (c) { return c.trim() !== ''; }).map(function (c) { return c.trim(); });
            html += '<tr>';
            cells.forEach(function (c) { html += '<td>' + inlineMarkdown(c) + '</td>'; });
            html += '</tr>';
            i++;
        }

        html += '</tbody></table>';
        return { html, end: i };
    }

    function inlineMarkdown(text) {
        if (!text) return '';
        // Images
        text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
        // Links
        text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
        // Bold+Italic
        text = text.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
        // Bold
        text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        text = text.replace(/__(.+?)__/g, '<strong>$1</strong>');
        // Italic
        text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
        text = text.replace(/_(.+?)_/g, '<em>$1</em>');
        // Strikethrough
        text = text.replace(/~~(.+?)~~/g, '<del>$1</del>');
        // Inline code
        text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
        // Line breaks
        text = text.replace(/ {2}$/gm, '<br>');
        return text;
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Repair list structure produced by browser execCommand quirks:
    // 'indent' yields <ul><li/><ul/></ul>, 'outdent' yields <ul><li>x<li/></li></ul>.
    // Lift orphan lists into the preceding li, and lift nested li out as siblings.
    function normalizeListDom(root) {
        let safety = 100;
        let changed = true;
        while (changed && safety-- > 0) {
            changed = false;
            root.querySelectorAll('li > li').forEach(function (innerLi) {
                const outerLi = innerLi.parentNode;
                outerLi.parentNode.insertBefore(innerLi, outerLi.nextSibling);
                changed = true;
            });
            root.querySelectorAll('ul > ul, ul > ol, ol > ul, ol > ol').forEach(function (orphan) {
                const prevLi = orphan.previousElementSibling;
                if (prevLi && prevLi.tagName === 'LI') {
                    prevLi.appendChild(orphan);
                    changed = true;
                }
            });
        }
    }

    // ─── HTML → Markdown Serializer ──────────────────────────
    function htmlToMarkdown(element) {
        let md = '';
        const nodes = element.childNodes;

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (node.nodeType === Node.TEXT_NODE) {
                md += node.textContent;
                continue;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) continue;

            const tag = node.tagName.toLowerCase();

            switch (tag) {
                case 'h1': md += '# ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'h2': md += '## ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'h3': md += '### ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'h4': md += '#### ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'h5': md += '##### ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'h6': md += '###### ' + getInlineMarkdown(node) + '\n\n'; break;
                case 'p': md += getInlineMarkdown(node) + '\n\n'; break;
                case 'blockquote':
                    md += htmlToMarkdown(node).split('\n').filter(function (l) { return l.trim() !== '' || l === ''; }).map(function (l) { return '> ' + l; }).join('\n') + '\n\n';
                    break;
                case 'ul':
                    md += serializeList(node, 'ul') + '\n';
                    break;
                case 'ol':
                    md += serializeList(node, 'ol') + '\n';
                    break;
                case 'pre': {
                    const code = node.querySelector('code');
                    const langClass = code ? code.className : '';
                    const lang = langClass.replace('language-', '');
                    const text = code ? code.textContent : node.textContent;
                    md += '```' + lang + '\n' + text + '\n```\n\n';
                    break;
                }
                case 'hr': md += '---\n\n'; break;
                case 'table': md += serializeTable(node) + '\n\n'; break;
                case 'br': md += '\n'; break;
                case 'div': md += htmlToMarkdown(node) + '\n'; break;
                default: md += getInlineMarkdown(node); break;
            }
        }

        return md;
    }

    function getInlineMarkdown(element) {
        let md = '';
        const nodes = element.childNodes;

        for (let i = 0; i < nodes.length; i++) {
            const node = nodes[i];

            if (node.nodeType === Node.TEXT_NODE) {
                md += node.textContent;
                continue;
            }

            if (node.nodeType !== Node.ELEMENT_NODE) continue;

            const tag = node.tagName.toLowerCase();

            switch (tag) {
                case 'strong': case 'b':
                    md += '**' + getInlineMarkdown(node) + '**';
                    break;
                case 'em': case 'i':
                    md += '*' + getInlineMarkdown(node) + '*';
                    break;
                case 'del': case 's':
                    md += '~~' + getInlineMarkdown(node) + '~~';
                    break;
                case 'code':
                    md += '`' + node.textContent + '`';
                    break;
                case 'a':
                    md += '[' + getInlineMarkdown(node) + '](' + (node.getAttribute('href') || '') + ')';
                    break;
                case 'img':
                    md += '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
                    break;
                case 'br':
                    md += '  \n';
                    break;
                case 'input':
                    md += node.checked ? '[x] ' : '[ ] ';
                    break;
                default:
                    md += getInlineMarkdown(node);
                    break;
            }
        }

        return md;
    }

    function serializeList(listEl, type, depth) {
        depth = depth || 0;
        const indentStr = '  '.repeat(depth);
        let md = '';
        let counter = 0;
        // Iterate direct children: handles both well-formed (LI > UL/OL) and
        // browser-quirk structures (UL > UL/OL, produced by execCommand('indent')).
        Array.from(listEl.children).forEach(function (child) {
            const childTag = child.tagName.toLowerCase();
            if (childTag === 'li') {
                counter++;
                const prefix = type === 'ol' ? counter + '. ' : '- ';
                const clone = child.cloneNode(true);
                Array.from(clone.children).forEach(function (c) {
                    if (c.tagName === 'UL' || c.tagName === 'OL') c.remove();
                });
                md += indentStr + prefix + getInlineMarkdown(clone).trim() + '\n';
                Array.from(child.children).forEach(function (nested) {
                    if (nested.tagName === 'UL' || nested.tagName === 'OL') {
                        md += serializeList(nested, nested.tagName.toLowerCase(), depth + 1);
                    }
                });
            } else if (childTag === 'ul' || childTag === 'ol') {
                md += serializeList(child, childTag, depth + 1);
            }
        });
        return md;
    }

    function serializeTable(tableEl) {
        let md = '';
        const headers = tableEl.querySelectorAll('thead th');
        const rows = tableEl.querySelectorAll('tbody tr');

        if (headers.length > 0) {
            md += '| ' + Array.from(headers).map(function (h) { return getInlineMarkdown(h).trim(); }).join(' | ') + ' |\n';
            md += '| ' + Array.from(headers).map(function () { return '---'; }).join(' | ') + ' |\n';
        }

        rows.forEach(function (row) {
            const cells = row.querySelectorAll('td');
            md += '| ' + Array.from(cells).map(function (c) { return getInlineMarkdown(c).trim(); }).join(' | ') + ' |\n';
        });

        return md;
    }

    // ─── Initialize ──────────────────────────────────────────
    // Initial content is set via message from extension host
    vscode.postMessage({ type: 'requestContent' });

    // ─── Save Logic ──────────────────────────────────────────
    function scheduleSave() {
        if (ignoreNextInput) {
            ignoreNextInput = false;
            return;
        }
        clearTimeout(saveTimeout);
        status.textContent = 'Editing...';
        saveTimeout = setTimeout(function () {
            const snapshot = editor.cloneNode(true);
            normalizeListDom(snapshot);
            const markdown = htmlToMarkdown(snapshot).replace(/\n{3,}/g, '\n\n').trim() + '\n';
            isSaving = true;
            vscode.postMessage({ type: 'update', markdown: markdown });
            status.textContent = 'Saved';
            setTimeout(function () { status.textContent = 'Ready'; }, 1500);
        }, 800);
    }

    editor.addEventListener('input', scheduleSave);

    // Checkbox handling
    editor.addEventListener('change', function (e) {
        if (e.target && e.target.type === 'checkbox') {
            scheduleSave();
        }
    });

    // ─── Toolbar Commands ────────────────────────────────────
    function execCmd(command, value) {
        document.execCommand(command, false, value || null);
        editor.focus();
        scheduleSave();
    }

    document.getElementById('btnBold').addEventListener('click', function () { execCmd('bold'); });
    document.getElementById('btnItalic').addEventListener('click', function () { execCmd('italic'); });
    document.getElementById('btnStrike').addEventListener('click', function () { execCmd('strikeThrough'); });
    document.getElementById('btnUndo').addEventListener('click', function () { execCmd('undo'); });
    document.getElementById('btnRedo').addEventListener('click', function () { execCmd('redo'); });

    document.getElementById('btnCode').addEventListener('click', function () {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            const text = range.toString();
            if (text) {
                const code = document.createElement('code');
                code.textContent = text;
                range.deleteContents();
                range.insertNode(code);
                scheduleSave();
            }
        }
    });

    document.getElementById('btnUl').addEventListener('click', function () { execCmd('insertUnorderedList'); });
    document.getElementById('btnOl').addEventListener('click', function () { execCmd('insertOrderedList'); });
    document.getElementById('btnIndent').addEventListener('click', function () { execCmd('indent'); });
    document.getElementById('btnOutdent').addEventListener('click', function () { execCmd('outdent'); });

    document.getElementById('btnTaskList').addEventListener('click', function () {
        // Check if we're already inside a list item
        const sel = window.getSelection();
        let node = sel.anchorNode;
        let inList = false;
        while (node && node !== editor) {
            if (node.tagName === 'LI') { inList = true; break; }
            node = node.parentNode;
        }

        if (inList) {
            // Convert current list item to a task item
            const li = node;
            if (!li.querySelector('input[type="checkbox"]')) {
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                li.insertBefore(checkbox, li.firstChild);
                li.insertBefore(document.createTextNode(' '), checkbox.nextSibling);
                scheduleSave();
            }
        } else {
            // Insert a fresh task list outside any existing list
            const ul = document.createElement('ul');
            const li = document.createElement('li');
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            li.appendChild(checkbox);
            li.appendChild(document.createTextNode(' Task item'));
            ul.appendChild(li);

            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(ul);

            // Place cursor after checkbox
            const textNode = li.lastChild;
            const newRange = document.createRange();
            newRange.setStart(textNode, 1);
            newRange.collapse(true);
            sel.removeAllRanges();
            sel.addRange(newRange);
            scheduleSave();
        }
    });

    document.getElementById('btnQuote').addEventListener('click', function () {
        const sel = window.getSelection();
        const text = sel.toString() || 'Blockquote';
        execCmd('insertHTML', '<blockquote><p>' + text + '</p></blockquote>');
    });

    document.getElementById('btnCodeBlock').addEventListener('click', function () {
        execCmd('insertHTML', '<pre><code>code here</code></pre>');
    });

    document.getElementById('btnHr').addEventListener('click', function () {
        execCmd('insertHorizontalRule');
    });

    // Block type selector
    blockType.addEventListener('change', function () {
        execCmd('formatBlock', '<' + blockType.value + '>');
    });

    // Update block type indicator on cursor move
    document.addEventListener('selectionchange', function () {
        const sel = window.getSelection();
        if (!sel.rangeCount) return;
        let node = sel.anchorNode;
        if (node && node.nodeType === Node.TEXT_NODE) node = node.parentNode;

        while (node && node !== editor) {
            const tag = node.tagName ? node.tagName.toLowerCase() : '';
            if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p'].indexOf(tag) >= 0) {
                blockType.value = tag;
                break;
            }
            node = node.parentNode;
        }
    });

    // ─── Link Modal ──────────────────────────────────────────
    const linkModal = document.getElementById('linkModal');
    const linkText = document.getElementById('linkText');
    const linkUrl = document.getElementById('linkUrl');

    document.getElementById('btnLink').addEventListener('click', function () {
        saveSelection();
        const sel = window.getSelection();
        linkText.value = sel.toString() || '';
        linkUrl.value = '';
        linkModal.classList.add('visible');
        linkUrl.focus();
    });

    document.getElementById('linkCancel').addEventListener('click', function () {
        linkModal.classList.remove('visible');
        restoreSelection();
    });

    document.getElementById('linkInsert').addEventListener('click', function () {
        linkModal.classList.remove('visible');
        restoreSelection();
        const text = linkText.value || linkUrl.value;
        const url = linkUrl.value;
        if (url) {
            const a = document.createElement('a');
            a.href = url;
            a.textContent = text;
            const sel = window.getSelection();
            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(a);
                // Place cursor after the link
                range.setStartAfter(a);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
            scheduleSave();
        }
    });

    // ─── Image Modal ─────────────────────────────────────────
    const imageModal = document.getElementById('imageModal');
    const imageAlt = document.getElementById('imageAlt');
    const imageUrl = document.getElementById('imageUrl');

    document.getElementById('btnImage').addEventListener('click', function () {
        saveSelection();
        imageAlt.value = '';
        imageUrl.value = '';
        imageModal.classList.add('visible');
        imageUrl.focus();
    });

    document.getElementById('imageCancel').addEventListener('click', function () {
        imageModal.classList.remove('visible');
        restoreSelection();
    });

    document.getElementById('imageInsert').addEventListener('click', function () {
        imageModal.classList.remove('visible');
        restoreSelection();
        const url = imageUrl.value;
        if (url) {
            const img = document.createElement('img');
            img.src = url;
            img.alt = imageAlt.value;
            const sel = window.getSelection();
            if (sel.rangeCount > 0) {
                const range = sel.getRangeAt(0);
                range.deleteContents();
                range.insertNode(img);
                range.setStartAfter(img);
                range.collapse(true);
                sel.removeAllRanges();
                sel.addRange(range);
            }
            scheduleSave();
        }
    });

    // ─── Table Insert & Controls ───────────────────────────────
    document.getElementById('btnTable').addEventListener('click', function () {
        const table = document.createElement('table');
        table.innerHTML = '<thead><tr><th>Header 1</th><th>Header 2</th><th>Header 3</th></tr></thead><tbody><tr><td>Cell 1</td><td>Cell 2</td><td>Cell 3</td></tr><tr><td>Cell 4</td><td>Cell 5</td><td>Cell 6</td></tr></tbody>';

        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(table);
            range.setStartAfter(table);
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
        }
        scheduleSave();
    });

    // Floating table controls
    const tableControls = document.getElementById('tableControls');

    function getActiveTable() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return null;
        let node = sel.anchorNode;
        while (node && node !== editor) {
            if (node.tagName === 'TABLE') return node;
            node = node.parentNode;
        }
        return null;
    }

    function getActiveCell() {
        const sel = window.getSelection();
        if (!sel.rangeCount) return null;
        let node = sel.anchorNode;
        while (node && node !== editor) {
            if (node.tagName === 'TD' || node.tagName === 'TH') return node;
            node = node.parentNode;
        }
        return null;
    }

    function showTableControls() {
        const table = getActiveTable();
        if (table) {
            const rect = table.getBoundingClientRect();
            const containerRect = editor.parentElement.getBoundingClientRect();
            tableControls.style.top = (rect.top - containerRect.top + editor.parentElement.scrollTop - 32) + 'px';
            tableControls.style.left = (rect.left - containerRect.left) + 'px';
            tableControls.classList.add('visible');
        } else {
            tableControls.classList.remove('visible');
        }
    }

    document.addEventListener('selectionchange', showTableControls);
    editor.addEventListener('click', showTableControls);

    document.getElementById('tblAddRowAbove').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const row = cell.parentElement;
        const table = getActiveTable();
        const colCount = row.children.length;
        const newRow = document.createElement('tr');
        const isHeader = cell.tagName === 'TH';
        for (let c = 0; c < colCount; c++) {
            const td = document.createElement(isHeader ? 'th' : 'td');
            td.textContent = '\u00A0';
            newRow.appendChild(td);
        }
        row.parentElement.insertBefore(newRow, row);
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblAddRowBelow').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const row = cell.parentElement;
        const colCount = row.children.length;
        const newRow = document.createElement('tr');
        for (let c = 0; c < colCount; c++) {
            const td = document.createElement('td');
            td.textContent = '\u00A0';
            newRow.appendChild(td);
        }
        // If in thead, add to tbody instead
        if (row.parentElement.tagName === 'THEAD') {
            const tbody = row.closest('table').querySelector('tbody');
            if (tbody) {
                tbody.insertBefore(newRow, tbody.firstChild);
            }
        } else {
            row.parentElement.insertBefore(newRow, row.nextSibling);
        }
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblAddColLeft').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const table = getActiveTable();
        const colIdx = Array.from(cell.parentElement.children).indexOf(cell);
        table.querySelectorAll('tr').forEach(function (row) {
            const isHeader = row.parentElement.tagName === 'THEAD';
            const newCell = document.createElement(isHeader ? 'th' : 'td');
            newCell.textContent = isHeader ? 'Header' : '\u00A0';
            row.insertBefore(newCell, row.children[colIdx]);
        });
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblAddColRight').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const table = getActiveTable();
        const colIdx = Array.from(cell.parentElement.children).indexOf(cell);
        table.querySelectorAll('tr').forEach(function (row) {
            const isHeader = row.parentElement.tagName === 'THEAD';
            const newCell = document.createElement(isHeader ? 'th' : 'td');
            newCell.textContent = isHeader ? 'Header' : '\u00A0';
            const ref = row.children[colIdx];
            row.insertBefore(newCell, ref ? ref.nextSibling : null);
        });
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblDeleteRow').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const row = cell.parentElement;
        const table = getActiveTable();
        // Don't delete the last row or the header row
        const allRows = table.querySelectorAll('tr');
        if (allRows.length <= 1) return;
        if (row.parentElement.tagName === 'THEAD' && table.querySelectorAll('thead tr').length <= 1) return;
        row.remove();
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblDeleteCol').addEventListener('click', function () {
        const cell = getActiveCell();
        if (!cell) return;
        const table = getActiveTable();
        const colIdx = Array.from(cell.parentElement.children).indexOf(cell);
        const firstRow = table.querySelector('tr');
        if (firstRow && firstRow.children.length <= 1) return; // Don't delete last column
        table.querySelectorAll('tr').forEach(function (row) {
            if (row.children[colIdx]) row.children[colIdx].remove();
        });
        scheduleSave();
        showTableControls();
    });

    document.getElementById('tblDeleteTable').addEventListener('click', function () {
        const table = getActiveTable();
        if (table) {
            table.remove();
            tableControls.classList.remove('visible');
            scheduleSave();
        }
    });

    // ─── Keyboard Shortcuts ──────────────────────────────────
    editor.addEventListener('keydown', function (e) {
        if (e.ctrlKey || e.metaKey) {
            switch (e.key) {
                case 'b': e.preventDefault(); execCmd('bold'); break;
                case 'i': e.preventDefault(); execCmd('italic'); break;
                case 'u': e.preventDefault(); execCmd('underline'); break;
                case 'z':
                    // Let the browser handle Ctrl+Z (undo) and Ctrl+Shift+Z (redo) natively
                    break;
                case 'y': e.preventDefault(); execCmd('redo'); break;
            }
        }

        // Tab: indent/outdent in lists, or insert spaces in code blocks
        if (e.key === 'Tab') {
            const sel = window.getSelection();
            let node = sel.anchorNode;
            while (node && node !== editor) {
                if (node.tagName === 'LI') {
                    e.preventDefault();
                    execCmd(e.shiftKey ? 'outdent' : 'indent');
                    return;
                }
                if (node.tagName === 'PRE' || node.tagName === 'CODE') {
                    if (!e.shiftKey) {
                        e.preventDefault();
                        execCmd('insertText', '    ');
                    }
                    return;
                }
                node = node.parentNode;
            }
        }
    });

    // ─── Message Handling from Extension ─────────────────────
    window.addEventListener('message', function (event) {
        const message = event.data;
        if (message.type === 'setContent') {
            // If this was triggered by our own save, skip the update to preserve undo stack
            if (isSaving) {
                isSaving = false;
                return;
            }

            ignoreNextInput = true;

            // Save cursor position
            const sel = window.getSelection();
            let savedOffset = 0;
            if (sel.rangeCount) {
                const range = sel.getRangeAt(0);
                const preRange = range.cloneRange();
                preRange.selectNodeContents(editor);
                preRange.setEnd(range.startContainer, range.startOffset);
                savedOffset = preRange.toString().length;
            }

            editor.innerHTML = markdownToHtml(message.markdown);

            // Restore approximate cursor position
            try {
                const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
                let charCount = 0;
                let targetNode = null;
                let targetOffset = 0;

                while (walker.nextNode()) {
                    const len = walker.currentNode.textContent.length;
                    if (charCount + len >= savedOffset) {
                        targetNode = walker.currentNode;
                        targetOffset = savedOffset - charCount;
                        break;
                    }
                    charCount += len;
                }

                if (targetNode) {
                    const newRange = document.createRange();
                    newRange.setStart(targetNode, Math.min(targetOffset, targetNode.textContent.length));
                    newRange.collapse(true);
                    sel.removeAllRanges();
                    sel.addRange(newRange);
                }
            } catch (e) {
                // cursor restore is best-effort
            }
        }
    });

    // ─── Drag & Drop Images ──────────────────────────────────
    editor.addEventListener('dragover', function (e) {
        e.preventDefault();
    });

    editor.addEventListener('drop', function (e) {
        e.preventDefault();
        const files = e.dataTransfer.files;
        if (files.length > 0 && files[0].type.startsWith('image/')) {
            const reader = new FileReader();
            reader.onload = function (ev) {
                execCmd('insertHTML', '<img src="' + ev.target.result + '" alt="Dropped image">');
            };
            reader.readAsDataURL(files[0]);
        }
    });
})();
