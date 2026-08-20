// Independent Text Format tool — no shared state with script.js
// Must load after script.js in index.html (uses toast, lucide from global scope)
//
// The XHTML document is rendered inside a same-origin sandboxed iframe
// (#fmtFrame), loaded from a Blob with type "application/xhtml+xml" so the
// browser's real XML parser handles it — no HTML5-parser corruption
// (self-closing tags surviving, no xmlns injected per element, no entity
// decoding surprises). Selection/Range APIs are taken from the iframe's own
// contentWindow, and export serializes straight out of the iframe's
// document via XMLSerializer.

let fmtOriginalRawText = '';
let fmtFileName = '';
let fmtFormatUndoStack = [];
let fmtFileLoaded = false;
let activeFmtPopover = null;

function isFormatTabActive() {
  const fmtArea = document.getElementById('fmtArea');
  return !!fmtArea && !fmtArea.hidden;
}

function getFmtFrame() {
  return document.getElementById('fmtFrame');
}

function getFmtWin() {
  return getFmtFrame()?.contentWindow || null;
}

function getFmtDoc() {
  return getFmtFrame()?.contentDocument || null;
}

function fmtParseAndRender(text) {
  const fmtFrame = getFmtFrame();
  const emptyState = document.getElementById('fmtEmptyState');
  if (!fmtFrame) throw new Error('Format frame not found');

  const blob = new Blob([text], { type: 'application/xhtml+xml' });
  const url = URL.createObjectURL(blob);

  fmtFrame.onload = () => {
    URL.revokeObjectURL(url);
    const doc = fmtFrame.contentDocument;
    if (!doc || doc.querySelector('parsererror')) {
      toast('Failed to parse file as XHTML', '');
      return;
    }

    doc.querySelectorAll('p.ref[id]').forEach(el => el.classList.add('ref-block'));
    injectFmtDocStyles(doc);
    attachFmtDocListeners(doc);

    fmtFormatUndoStack = [];
    if (emptyState) emptyState.hidden = true;
    fmtFrame.hidden = false;
    if (window.lucide) lucide.createIcons();
  };

  fmtFrame.src = url;
}

function injectFmtDocStyles(doc) {
  const style = doc.createElement('style');
  style.textContent = `
    body{margin:0;padding:20px 24px;font-family:'JetBrains Mono',monospace;font-size:13px;line-height:1.9;color:#1c1e26;background:#ffffff;}
    [data-human="true"]{background-color:rgba(255,220,100,0.4);border-radius:2px;padding:0 2px;transition:background-color .3s ease;}
    [data-human="true"]:hover{background-color:rgba(255,200,50,0.65);}
  `;
  doc.head.appendChild(style);
}

function attachFmtDocListeners(doc) {
  doc.addEventListener('click', e => {
    const target = e.target.closest('[data-human="true"]');
    if (target) {
      e.stopPropagation();
      showFmtPopover(target);
    } else {
      removeFmtPopover();
    }
  });
  doc.addEventListener('scroll', removeFmtPopover, true);
  doc.addEventListener('keydown', handleFmtUndoKeydown, true);
  doc.addEventListener('keydown', handleFmtShortcutKeydown, true);
}

function fmtSaveUndoSnapshot(range) {
  const container = range.commonAncestorContainer;
  const parentEl = container.nodeType === Node.TEXT_NODE ? container.parentElement : container;
  const doc = getFmtDoc();
  const block = parentEl?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, div') || parentEl || doc?.body;
  if (!block) return;
  fmtFormatUndoStack.push({ block, html: block.innerHTML });
  if (fmtFormatUndoStack.length > 50) fmtFormatUndoStack.shift();
}

function wrapFmtSelection(tagName, className) {
  const doc = getFmtDoc();
  const win = getFmtWin();
  if (!doc || !win) {
    toast('No file loaded', '');
    return;
  }

  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    toast('Select some text first', '');
    return;
  }
  const range = sel.getRangeAt(0);
  const startEl = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer.parentElement
    : range.commonAncestorContainer;
  if (startEl?.closest('.ref-block')) {
    toast('Cannot format reference blocks', '');
    return;
  }

  fmtSaveUndoSnapshot(range);

  // Walk up from both endpoints to find an existing same-type human tag
  const existingTag =
    range.startContainer.parentElement?.closest(`${tagName}[data-human="true"]`) ||
    range.endContainer.parentElement?.closest(`${tagName}[data-human="true"]`);

  if (existingTag && doc.contains(existingTag)) {
    // Expand the range to cover both the existing tag and the new selection
    const merged = doc.createRange();

    const existingStart = doc.createRange();
    existingStart.selectNode(existingTag);
    if (range.compareBoundaryPoints(Range.START_TO_START, existingStart) < 0) {
      merged.setStart(range.startContainer, range.startOffset);
    } else {
      merged.setStartBefore(existingTag);
    }

    if (range.compareBoundaryPoints(Range.END_TO_END, existingStart) > 0) {
      merged.setEnd(range.endContainer, range.endOffset);
    } else {
      merged.setEndAfter(existingTag);
    }

    const frag = merged.extractContents();
    frag.querySelectorAll(`${tagName}[data-human="true"]`).forEach(inner => {
      while (inner.firstChild) inner.parentNode.insertBefore(inner.firstChild, inner);
      inner.remove();
    });

    const el = doc.createElement(tagName);
    el.setAttribute('data-human', 'true');
    if (className) el.className = className;
    el.appendChild(frag);
    merged.insertNode(el);
  } else {
    const frag = range.extractContents();
    frag.querySelectorAll(`${tagName}[data-human="true"]`).forEach(inner => {
      while (inner.firstChild) inner.parentNode.insertBefore(inner.firstChild, inner);
      inner.remove();
    });
    const el = doc.createElement(tagName);
    el.setAttribute('data-human', 'true');
    if (className) el.className = className;
    el.appendChild(frag);
    range.insertNode(el);
  }

  doc.querySelectorAll('[data-human="true"]').forEach(el => {
    if (!el.textContent.trim() && !el.children.length) el.remove();
  });

  doc.body.normalize();
  sel.removeAllRanges();
  toast('Formatted & Highlighted', 'success');
}

function fmtUndo() {
  if (fmtFormatUndoStack.length === 0) {
    toast('Nothing to undo', '');
    return;
  }
  const last = fmtFormatUndoStack.pop();
  last.block.innerHTML = last.html;
  toast('Undo successful', 'success');
}

function reEncodeEntities(str) {
  return str
    .replace(/’/g, '&#x2019;')
    .replace(/‘/g, '&#x2018;')
    .replace(/“/g, '&#x201C;')
    .replace(/”/g, '&#x201D;')
    .replace(/–/g, '&#x2013;')
    .replace(/—/g, '&#x2014;')
    .replace(/ /g, '&#x00A0;')
    .replace(/…/g, '&#x2026;')
    .replace(/­/g, '&#x00AD;')
    .replace(/‒/g, '&#x2012;')
    .replace(/‑/g, '&#x2011;')
    .replace(/°/g, '&#x00B0;')
    .replace(/·/g, '&#x00B7;')
    .replace(/•/g, '&#x2022;')
    .replace(/ /g, '&#x2003;')
    .replace(/ /g, '&#x2002;')
    .replace(/ /g, '&#x2009;');
}

function buildFmtSerializedExport() {
  const doc = getFmtDoc();
  if (!doc) return fmtOriginalRawText;

  // Collect all user-added formatting tags in DOM order
  const humanTags = [];
  doc.querySelectorAll('[data-human="true"]').forEach(el => {
    const tag = el.tagName.toLowerCase();
    const className = el.getAttribute('class') || null;
    const text = el.textContent; // decoded unicode
    humanTags.push({ tag, className, text });
  });

  if (humanTags.length === 0) return fmtOriginalRawText;

  let result = fmtOriginalRawText;

  humanTags.forEach(({ tag, className, text }) => {
    if (!text.trim()) return;

    // Build a pattern that matches the text accounting for encoded entities
    const pattern = text.split('').map(ch => {
      const code = ch.charCodeAt(0);
      const hex = code.toString(16).toLowerCase();
      const hexUpper = hex.toUpperCase();
      const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Whitespace variants
      if (/\s/.test(ch)) {
        return `(?:&#${code};|&#x0*${hex};|&#x0*${hexUpper};|&nbsp;|\\s)`;
      }

      // Plain ASCII alphanumeric — no entity encoding expected
      if (/[a-zA-Z0-9]/.test(ch)) return ch;

      // Everything else — match raw char OR any decimal/hex entity form
      return `(?:${esc}|&#${code};|&#x0*${hex};|&#x0*${hexUpper};)`;
    }).join('');

    const openTag = className
      ? `<${tag} class="${className}">`
      : `<${tag}>`;
    const closeTag = `</${tag}>`;

    // Skip if already wrapped
    const alreadyRe = new RegExp(`${openTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}${pattern}`);
    if (alreadyRe.test(result)) return;

    const re = new RegExp(pattern);
    const m = re.exec(result);
    if (m) {
      result = result.slice(0, m.index) +
               openTag + m[0] + closeTag +
               result.slice(m.index + m[0].length);
    }
  });

  return result;
}

function fmtExportXHTML() {
  if (!fmtFileLoaded) {
    toast('No file loaded', '');
    return;
  }
  const output = buildFmtSerializedExport();
  const blob = new Blob([output], { type: 'application/xhtml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fmtFileName || 'formatted.xhtml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function fmtCopyXHTML() {
  if (!fmtFileLoaded) {
    toast('No file loaded', '');
    return;
  }
  const output = buildFmtSerializedExport();
  navigator.clipboard.writeText(output);
  toast('XHTML copied to clipboard', 'success');
}

function showFmtPopover(targetEl) {
  removeFmtPopover();

  const fmtFrame = getFmtFrame();
  const frameRect = fmtFrame.getBoundingClientRect();
  const rect = targetEl.getBoundingClientRect();

  const popover = document.createElement('div');
  popover.className = 'fmt-popover';

  const tagName = targetEl.tagName.toLowerCase();
  popover.innerHTML = `
    <span class="fmt-popover-text">Formatted as &lt;${tagName}&gt;</span>
    <button class="fmt-popover-btn" id="removeFmtTagBtn">
      <i data-lucide="trash-2" style="width:14px;height:14px;"></i> Remove
    </button>
  `;

  document.body.appendChild(popover);
  activeFmtPopover = popover;

  // Position popover above the highlighted text element (offset by the
  // iframe's own position in the parent page, since rect is iframe-local)
  const popoverRect = popover.getBoundingClientRect();
  const top = frameRect.top + rect.top + window.scrollY - popoverRect.height - 8;
  const left = frameRect.left + rect.left + window.scrollX + (rect.width / 2) - (popoverRect.width / 2);

  popover.style.top = `${Math.max(10, top)}px`;
  popover.style.left = `${Math.max(10, left)}px`;

  if (window.lucide) lucide.createIcons();

  document.getElementById('removeFmtTagBtn').addEventListener('click', () => {
    const doc = getFmtDoc();
    if (doc) {
      const undoRange = doc.createRange();
      undoRange.selectNode(targetEl);
      fmtSaveUndoSnapshot(undoRange);
    }

    const parent = targetEl.parentNode;
    while (targetEl.firstChild) {
      parent.insertBefore(targetEl.firstChild, targetEl);
    }
    parent.removeChild(targetEl);

    removeFmtPopover();
    toast('Formatting removed', 'info');
  });
}

function removeFmtPopover() {
  if (activeFmtPopover) {
    activeFmtPopover.remove();
    activeFmtPopover = null;
  }
}

window.addEventListener('resize', removeFmtPopover);
document.addEventListener('click', e => {
  if (!e.target.closest('.fmt-popover')) removeFmtPopover();
});

function handleFmtUndoKeydown(e) {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && isFormatTabActive()) {
    e.preventDefault();
    e.stopPropagation();
    fmtUndo();
  }
}

function handleFmtShortcutKeydown(e) {
  if (!isFormatTabActive()) return;

  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) return;

  const shift = e.shiftKey;
  const key = e.key.toLowerCase();
  let tag = null, cls = null;

  if (!shift && key === 'b') { tag = 'b'; }
  else if (!shift && key === 'i') { tag = 'i'; }
  else if (!shift && key === 'u') { tag = 'u'; }
  else if (shift && key === 's') { tag = 's'; }
  else if (shift && key === 'p') { tag = 'sup'; }
  else if (shift && key === 'b') { tag = 'sub'; }
  else if (shift && key === 'k') { tag = 'span'; cls = 'smallcaps'; }

  if (tag) {
    e.preventDefault();
    e.stopPropagation();
    wrapFmtSelection(tag, cls);
  }
}

function initFormatTool() {
  if (window._fmtToolInitialized) return;
  window._fmtToolInitialized = true;

  const fmtToolbar = document.getElementById('fmtToolbar');
  const fmtExportBtn = document.getElementById('fmtExportBtn');
  const fmtCopyBtn = document.getElementById('fmtCopyBtn');

  // Toolbar buttons
  fmtToolbar.querySelectorAll('.fmt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      wrapFmtSelection(btn.dataset.tag, btn.dataset.class || null);
    });
  });

  fmtExportBtn.addEventListener('click', fmtExportXHTML);
  fmtCopyBtn.addEventListener('click', fmtCopyXHTML);

  // Prevent citation popup while format tab is active
  document.getElementById('contentArea').addEventListener('mouseup', e => {
    if (isFormatTabActive()) e.stopImmediatePropagation();
  }, true);

  // Undo + format shortcuts fired while focus is on the parent page
  // (focus/selection inside the iframe is handled by attachFmtDocListeners,
  // since keyboard events inside an iframe never bubble to the parent doc)
  document.addEventListener('keydown', handleFmtUndoKeydown, true);
  document.addEventListener('keydown', handleFmtShortcutKeydown);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFormatTool);
} else {
  initFormatTool();
}
