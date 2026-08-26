lucide.createIcons();

function switchTab(activeTab) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === activeTab);
  });

  const isLinker = activeTab === 'linker';
  const isFormat = activeTab === 'format';
  const isCompare = activeTab === 'compare';

  // Control sidebar steps
  const sidebarSteps = document.getElementById('mainSidebarSteps') || document.getElementById('steps');
  if (sidebarSteps) sidebarSteps.hidden = isCompare;

  // Control Reference Linker elements
  const contentArea = document.getElementById('contentArea');
  const linkerMain = document.getElementById('linkerMain');
  const summaryBar = document.getElementById('summaryBar');
  const topActions = document.querySelector('.actions'); // Top-right Export/Copy/Compare group

  if (linkerMain) linkerMain.hidden = !isLinker;
  if (summaryBar) summaryBar.hidden = !isLinker;
  if (topActions) topActions.style.display = isLinker ? 'flex' : 'none';

  // Control Text Format elements
  const fmtArea = document.getElementById('fmtArea');
  if (fmtArea) fmtArea.hidden = !isFormat;

  // Control Compare elements
  const compareArea = document.getElementById('compareArea');
  if (compareArea) compareArea.hidden = !isCompare;
  if (isCompare && document.getElementById('diffOutput')) {
    document.getElementById('diffOutput').innerHTML = '';
  }

  if (window.lucide) lucide.createIcons();
}

// Global click delegation for all tabs
document.addEventListener('click', e => {
  const tabBtn = e.target.closest('.tab');
  if (tabBtn) {
    switchTab(tabBtn.dataset.tab);
  }
});
const CITATION_RE = /\(([A-Z][a-záéíóúñ'’\-]+)(?:\s+(?:and|&)\s+[A-Z][a-z]+)?\s+(?:et al\.?)?,?\s*(\d{4}[a-z]?)\)/g;

let originalRawText = '';
let refs = [];
let fuse = null;
let fileName = '';
let savedRange = null;
const undoStack = [];
let manualLinkedCount = 0;
let autoLinkedCount = 0;

const fileInput = document.getElementById('fileInput');
const dropzone = document.getElementById('dropzone');
const contentArea = document.getElementById('contentArea');
const summaryBar = document.getElementById('summaryBar');
const popup = document.getElementById('popup');
const popupTitle = document.getElementById('popupTitle');
const popupBody = document.getElementById('popupBody');
const popupClose = document.getElementById('popupClose');
const toastContainer = document.getElementById('toastContainer');
const exportBtn = document.getElementById('exportBtn');
const themeToggle = document.getElementById('themeToggle');

dropzone.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', e => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) loadFile(fileInput.files[0]);
});

function loadFile(file) {
  fileName = file.name;
  const reader = new FileReader();
  reader.onload = () => {
    originalRawText = reader.result;
    try {
      // Parse for Linker Tab
      parseAndRender(originalRawText);

      // Also Parse for Text Format Tab
      if (typeof fmtParseAndRender === 'function') {
        fmtFileName = fileName;
        fmtOriginalRawText = originalRawText;
        fmtParseAndRender(originalRawText);
        fmtFileLoaded = true;
      }

      // Update unified sidebar UI
      document.getElementById('fileNameOut').textContent = fileName;
      document.getElementById('charCountOut').textContent = originalRawText.length;

      // Re-enforce active tab visibility so Reference Linker bars stay hidden if currently on Text Format tab
      const activeTabBtn = document.querySelector('.tab.active');
      const activeTab = activeTabBtn ? activeTabBtn.dataset.tab : 'linker';
      switchTab(activeTab);

      toast(`Loaded ${fileName}`, 'success');
    } catch (err) {
      toast(`Failed to parse file: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

function stripDiacriticsAndSpecial(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’\-]/g, '');
}

function saveUndoSnapshot(element) {
  // text nodes don't have .closest() — get parent element first
  const el = element.nodeType === Node.TEXT_NODE ? element.parentElement : element;
  const block = el?.closest('p, li, h1, h2, h3, h4, h5, h6') || el?.parentNode || element.parentNode;
  undoStack.push({
    block: block,
    html: block.innerHTML
  });
  if (undoStack.length > 50) undoStack.shift(); // limit stack size
}

function extractRefNames(fullText) {
  const norm = fullText
    .replace(/&#x0026;/gi, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2019;/gi, "'")
    .replace(/&#x2018;/gi, "'")
    .trim();

  const hasEtAl = /\bet\s*al\b/i.test(norm);

  const PARTICLES = ['van der', 'van den', 'van de', 'von der', 'von', 'van', 'den', 'der', 'de', 'du', 'le', 'la'];

  const ORG_WORDS = ['council', 'commission', 'department', 'ministry', 'authority', 'agency', 'bureau', 'institute',
    'project', 'programme', 'program', 'association', 'society', 'trust', 'foundation', 'committee', 'board',
    'office', 'service', 'services', 'company', 'group', 'union', 'organization', 'organisation', 'city', 'district',
    'university', 'college', 'commons', 'house'];

  // Strip non-year bracketed content e.g. "(Bureau of Environmental Services)" but keep "(2019)" / "(2019a)"
  const stripped = norm.replace(/\(([^)]*[^0-9)][^)]*)\)/g, (m, inner) => {
    return /^\d{4}[a-z]?$/.test(inner.trim()) ? m : '';
  }).replace(/\s+/g, ' ').trim();

  const beforeYear = stripped.replace(/\s*\(?\d{4}[a-z]?\)?.*$/, '').trim();

  let allSurnames = [];
  let isOrg = false;
  let isAcronym = false;

  // ACRONYM detection — check FIRST
  const acronymRe = /^([A-Z]{2,8}(?:\s+and\s+[A-Z]{2,8})?)\s*[\s\(\.,]/;
  const acronymMatch = norm.match(acronymRe);
  if (acronymMatch) {
    const candidate = acronymMatch[1].trim();
    if (candidate === candidate.toUpperCase() && candidate.length >= 2) {
      isAcronym = true;
      allSurnames = [candidate];
    }
  }

  // LONG CAMELCASE ORG detection — check SECOND
  if (!isAcronym) {
    const firstTok = (beforeYear.split(/[\s,]+/)[0] || '').replace(/\.$/, '');
    const isMixedCase = /[a-z]/.test(firstTok) && /[A-Z]/.test(firstTok) && firstTok !== firstTok.toUpperCase();
    const looksLikeSurnamePattern = /^[A-Z][a-zA-Z\-]*\s*,\s*[A-Z]\./.test(beforeYear);
    if (firstTok.length > 10 && isMixedCase && !looksLikeSurnamePattern) {
      isOrg = true;
      allSurnames = [firstTok];
    }
  }

  // ORGANISATION detection — check THIRD
  if (!isAcronym && !isOrg) {
    const authorPortion = beforeYear.split(/\.\s+/)[0].trim();

    const orgWordHit = ORG_WORDS.some(w => new RegExp(`\\b${w}\\b`, 'i').test(authorPortion));

    const looksLikePersonList =
      /^[A-Z][a-zA-Z\-]*\s*,\s*[A-Z]\./.test(authorPortion) ||
      /^[A-Z][a-zA-Z\-]+\s+[A-Z]{1,3}\b/.test(authorPortion) ||
      /^[A-Z][a-zA-Z\-]*\s*,\s*[A-Z]{1,3}\s*,/.test(authorPortion);

    if (orgWordHit && !looksLikePersonList) {
      isOrg = true;
      allSurnames = [authorPortion];
    } else if (/^Anon\b/i.test(authorPortion)) {
      isOrg = true;
      allSurnames = ['Anon'];
    }
  }

  // FORMAT B — "Surname I, Surname2 I2 and Surname3 I3 (year)" — single-letter initial after surname
  if (!isAcronym && !isOrg) {
    const formatBRe = /^([A-Z][a-zA-Z\-]*(?:\s+[A-Z][a-zA-Z\-]*)*)\s+([A-Z]{1,3})\b(?=[,\s]|$)/;
    const isFormatB = formatBRe.test(beforeYear) && !/,\s*[A-Z]\./.test(beforeYear);
    if (isFormatB) {
      const tokens = beforeYear.split(/\s*(?:,|\s+and\s+|\s*&\s*)\s*/).filter(Boolean);
      tokens.forEach(tok => {
        const t = tok.trim();
        if (!t || /^et\s*al\.?$/i.test(t)) return;
        const m = t.match(/^(.+?)\s+[A-Z]{1,3}\.?$/);
        let surname = m ? m[1].trim() : t;
        for (const p of PARTICLES) {
          const re = new RegExp(`^(${p})\\s+(.+)$`, 'i');
          const pm = surname.match(re);
          if (pm) { surname = `${p} ${pm[2]}`; break; }
        }
        if (surname) allSurnames.push(surname);
      });
    }
  }

  // FORMAT A — APA "Surname, I. I., Surname2, I2. I2., ..."
  if (!isAcronym && !isOrg && allSurnames.length === 0) {
    const parts = beforeYear.split(',').map(s => s.trim()).filter(Boolean);
    let i = 0;
    while (i < parts.length) {
      let token = parts[i].replace(/^(and|&)\s+/i, '').trim();
      if (!token || /^et\s*al\.?$/i.test(token)) { i++; continue; }
      if (/^[A-Z]\.?(\s*[A-Z]\.?)*$/.test(token)) { i++; continue; }

      let surname = token.replace(/\s+(and|&)\s+.*$/i, '').trim();
      const surnameTokens = surname.split(/\s+/);
      const lastTok = surnameTokens[surnameTokens.length - 1];
      if (/^[A-Z]\.?$/.test(lastTok) && surnameTokens.length > 1) {
        surname = surnameTokens.slice(0, -1).join(' ');
      }
      for (const p of PARTICLES) {
        const re = new RegExp(`^(${p})\\s+`, 'i');
        if (re.test(surname)) break;
      }
      if (surname) allSurnames.push(surname);
      i++;
    }
  }

  // Fallback: single leading word as surname
  if (!isAcronym && !isOrg && allSurnames.length === 0) {
    const tok = beforeYear.split(/[\s,]+/)[0] || '';
    if (tok) allSurnames.push(tok);
  }

  if (hasEtAl && allSurnames.length > 1) {
    // keep collected names, et al. patterns generated separately using first author
  }

  const firstSurname = allSurnames[0] || '';
  const secondSurname = allSurnames[1] || '';

  const yearMatches = norm.match(/\b((?:19|20)\d{2}[a-z]?)\b/g) || [];
  const allYears = [...new Set(yearMatches)];

  return { firstSurname, secondSurname, allSurnames, allYears, isOrg, isAcronym };
}

function buildSearchPatterns(ref) {
  const { firstSurname, allSurnames = [], allYears, isOrg, isAcronym } = ref;
  if (!firstSurname) return [];

  const patterns = [];
  const push = p => { if (p && p.trim()) patterns.push(p.trim()); };

  const expandedYears = new Set();
  allYears.forEach(year => {
    expandedYears.add(year);
    expandedYears.add(year.replace(/[a-z]$/, ''));
  });

  expandedYears.forEach(year => {
    if (isOrg || isAcronym) {
      push(`(${firstSurname}, ${year})`);
      push(`(${firstSurname} (${year}))`);
      push(`${firstSurname}, ${year}`);
      push(`${firstSurname} (${year})`);
      return;
    }

    if (allSurnames.length <= 1) {
      push(`(${firstSurname}, ${year})`);
      push(`${firstSurname}, ${year}`);
      push(`${firstSurname} (${year})`);
      push(`(${firstSurname} et al., ${year})`);
      push(`(${firstSurname} et al. ${year})`);
      push(`${firstSurname} et al., ${year}`);
      push(`${firstSurname} et al. (${year})`);
      push(`${firstSurname} et al (${year})`);
      push(`${firstSurname}'s, ${year}`);
      push(`${firstSurname}'s (${year})`);
      ['e.g.', 'esp.', 'c.f.'].forEach(prefix => push(`${prefix} ${firstSurname}, ${year}`));
      return;
    }

    if (allSurnames.length === 2) {
      const [S1, S2] = allSurnames;
      push(`(${S1} and ${S2}, ${year})`);
      push(`(${S1} & ${S2}, ${year})`);
      push(`(${S1} and ${S2} (${year}))`);
      push(`(${S1} & ${S2} (${year}))`);
      push(`${S1} and ${S2}, ${year}`);
      push(`${S1} & ${S2}, ${year}`);
      push(`${S1} and ${S2} (${year})`);
      push(`${S1} & ${S2} (${year})`);
      push(`${S1} and ${S2}'s, ${year}`);
      push(`(${S1} et al., ${year})`);
      push(`${S1} et al., ${year}`);
      push(`${S1} et al. (${year})`);
      push(`${S1} et al (${year})`);
      push(`(${S1}, ${year})`);
      push(`${S1} (${year})`);
      push(`${S1}, ${year}`);
      return;
    }

    // 3+ authors — dynamic N
    const S1 = allSurnames[0];
    const allButLast = allSurnames.slice(0, -1).join(', ');
    const last = allSurnames[allSurnames.length - 1];

    const fullAnd = `${allButLast}, and ${last}`;
    const fullAnd2 = `${allButLast} and ${last}`;
    const fullAmp = `${allButLast}, & ${last}`;
    const fullAmp2 = `${allButLast} & ${last}`;

    push(`(${fullAnd}, ${year})`);
    push(`(${fullAnd2}, ${year})`);
    push(`(${fullAmp}, ${year})`);
    push(`(${fullAmp2}, ${year})`);
    push(`(${fullAnd} (${year}))`);
    push(`(${fullAmp} (${year}))`);
    push(`${fullAnd}, ${year}`);
    push(`${fullAnd2}, ${year}`);
    push(`${fullAmp}, ${year}`);
    push(`${fullAmp2}, ${year}`);
    push(`${fullAnd} (${year})`);
    push(`${fullAmp} (${year})`);

    push(`(${S1} et al., ${year})`);
    push(`(${S1} et al. ${year})`);
    push(`${S1} et al., ${year}`);
    push(`${S1} et al. (${year})`);
    push(`${S1} et al (${year})`);
    push(`(${S1}, ${year})`);
    push(`${S1} (${year})`);
    push(`${S1}, ${year}`);

    ['e.g.', 'esp.', 'c.f.'].forEach(prefix => push(`${prefix} ${S1} et al., ${year}`));
  });

  const result = [...new Set(patterns)].filter(p => /\d/.test(p));
  result.sort((a, b) => b.length - a.length);
  return result;
}

function normalizeForSearch(text) {
  return text
    .replace(/&#x0026;/gi, '&')
    .replace(/&#x26;/gi, '&')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2019;/gi, "'")
    .replace(/&#x2018;/gi, "'")
    .replace(/&#x201C;/gi, '"')
    .replace(/&#x201D;/gi, '"')
    .replace(/&#x2013;/gi, '-')
    .replace(/&#x2014;/gi, '-')
    .replace(/<[^>]*>/g, '')
    .replace(/\s*&\s*/g, ' & ')
    .replace(/([;,])(\S)/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAndRender(text) {
  let parsedDoc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
  if (parsedDoc.querySelector('parsererror')) {
    parsedDoc = new DOMParser().parseFromString(text, 'text/html');
  }
  const body = parsedDoc.body || parsedDoc.querySelector('body');
  if (!body) throw new Error('No body found in file');

  // extract refs
  refs = [];
  const refEls = body.querySelectorAll('p.ref[id]');
  refEls.forEach(el => {
    const fullText = el.textContent.trim();
    const id = el.getAttribute('id');
    const surname = (fullText.split(/[\s,]/)[0] || '').trim();
    const yearMatch = fullText.match(/\((\d{4}[a-z]?)\)/);
    const year = yearMatch ? yearMatch[1] : '';
    const { firstSurname, secondSurname, allSurnames, allYears, isOrg, isAcronym } = extractRefNames(fullText);
    refs.push({ id, text: fullText, surname, cleanSurname: stripDiacriticsAndSpecial(surname).toLowerCase(), year, firstSurname, secondSurname, allSurnames, allYears, isOrg, isAcronym });
  });

  fuse = new Fuse(refs, { keys: ['cleanSurname'], threshold: 0.5, includeScore: true });

  const bodyInner = Array.from(body.childNodes)
    .map(n => new XMLSerializer().serializeToString(n))
    .join('');

  contentArea.innerHTML = bodyInner;

  contentArea.querySelectorAll('img').forEach(img => {
    img.onerror = function() {
      this.style.display = 'none';
      const note = document.createElement('span');
      note.style.cssText = 'font-size:11px;color:var(--text-faint);font-style:italic;';
      note.textContent = '[image not available]';
      this.parentNode.insertBefore(note, this);
    };
  });

  // mark ref blocks
  contentArea.querySelectorAll('p.ref[id]').forEach(el => el.classList.add('ref-block'));

  // mark existing anchors wrapping citation-like text
  contentArea.querySelectorAll('a[href^="#"]').forEach(a => {
    if (/\(.*\d{4}[a-z]?\)/.test(a.textContent)) {
      a.classList.add('citation', 'linked');
    }
  });

  contentArea.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6, div').forEach(el => {
    if (!el.querySelector('p, li, div, h1, h2, h3, h4, h5, h6')) {
      el.classList.add('doc-line');
    }
  });

  document.getElementById('fileNameOut').textContent = fileName;
  document.getElementById('refCountOut').textContent = refs.length;

  updateStats();
  summaryBar.hidden = false;
  lucide.createIcons();
}

contentArea.addEventListener('click', e => {
  const a = e.target.closest('a[href^="#"]');
  if (a) e.preventDefault();
});

contentArea.addEventListener('click', e => {
  const a = e.target.closest('a.citation.linked');
  if (!a) return;
  e.preventDefault();
  showUnlinkPopup(a, e.pageX, e.pageY);
});

function showUnlinkPopup(anchor, x, y) {
  popupTitle.textContent = anchor.textContent;
  popupBody.innerHTML = `
    <div style="padding:10px;font-size:12px;color:var(--text-dim);margin-bottom:8px;">
      Unlink this citation?<br>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);">
        ${escapeHtml(anchor.getAttribute('href'))}
      </span>
    </div>
    <div style="display:flex;gap:8px;padding:0 10px 10px;">
      <button class="match-link-btn" id="unlinkConfirmBtn"
        style="background:var(--red);flex:1;">Delete</button>
      <button class="match-link-btn" id="unlinkCancelBtn"
        style="background:var(--bg-elev-2);color:var(--text);flex:1;">Cancel</button>
    </div>
  `;
  document.getElementById('unlinkConfirmBtn').addEventListener('click', () => {
    saveUndoSnapshot(anchor);
    // unwrap <a> keep text
    const text = document.createTextNode(anchor.textContent);
    anchor.replaceWith(text);
    // check if it was auto-linked
    if (anchor.classList.contains('auto-linked')) {
      autoLinkedCount = Math.max(0, autoLinkedCount - 1);
    } else {
      manualLinkedCount = Math.max(0, manualLinkedCount - 1);
    }
    closePopup();
    updateStats();
    toast('Citation unlinked', 'success');
  });
  document.getElementById('unlinkCancelBtn').addEventListener('click', closePopup);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  popup.style.left = Math.min(x, vw - 360) + 'px';
  popup.style.top = Math.min(y, vh - 420) + 'px';
  popup.hidden = false;
  lucide.createIcons();
}

function getOverlappingLink(range) {
  const links = contentArea.querySelectorAll('a.citation.linked');
  for (const link of links) {
    const linkRange = document.createRange();
    linkRange.selectNodeContents(link);
    // check if ranges overlap
    if (
      range.compareBoundaryPoints(Range.END_TO_START, linkRange) < 0 &&
      range.compareBoundaryPoints(Range.START_TO_END, linkRange) > 0
    ) {
      return link;
    }
  }
  return null;
}

function showExtendPopup(existingLink, newText, x, y) {
  const href = existingLink.getAttribute('href');
  const existingText = existingLink.textContent;

  // detect shrink vs extend
  const isShrink = existingText.includes(newText) && newText !== existingText;
  const isExtend = !existingText.includes(newText);
  const label = isShrink ? 'Shrink Link' : 'Extend Link';
  const btnLabel = isShrink ? 'Shrink' : 'Extend';

  popupTitle.textContent = newText;
  popupBody.innerHTML = `
    <div style="padding:10px;font-size:12px;color:var(--text-dim);margin-bottom:8px;">
      ${label}?<br>
      <span style="font-family:var(--font-mono);font-size:11px;color:var(--accent);">
        ${escapeHtml(href)}
      </span><br>
      <span style="font-size:11px;color:var(--text-faint);">
        From: "${escapeHtml(existingText)}"<br>
        To: "${escapeHtml(newText)}"
      </span>
    </div>
    <div style="display:flex;gap:8px;padding:0 10px 10px;">
      <button class="match-link-btn" id="extendConfirmBtn" style="flex:1;">${btnLabel}</button>
      <button class="match-link-btn" id="extendCancelBtn"
        style="background:var(--bg-elev-2);color:var(--text);flex:1;">Cancel</button>
    </div>
  `;
  document.getElementById('extendConfirmBtn').addEventListener('click', () => {
    try {
      const newSelectedText = savedRange.toString();
      const href2 = href; // capture href before DOM changes

      saveUndoSnapshot(existingLink);

      // Step 1: unwrap existing <a> into plain text
      // instead of replaceWith, use insertAdjacentText to keep DOM stable
      const parent = existingLink.parentNode;

      // create a temp span to hold position
      const marker = document.createElement('span');
      parent.insertBefore(marker, existingLink);

      // move text content out of <a>
      while (existingLink.firstChild) {
        parent.insertBefore(existingLink.firstChild, existingLink);
      }
      existingLink.remove();
      marker.remove();

      // Step 2: normalize parent to merge split text nodes
      parent.normalize();

      // Step 3: find newSelectedText across fragmented text nodes
      let freshRange = null;
      const allTextNodes = [];
      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) allTextNodes.push(node);

      // build combined string with offsets
      let combined = '';
      const offsets = [];
      allTextNodes.forEach(n => {
        offsets.push({ node: n, start: combined.length });
        combined += n.nodeValue;
      });

      // try exact match first
      let idx = combined.indexOf(newSelectedText);
      // if not found, try normalized (strip special chars)
      if (idx === -1) {
        const normalizedCombined = combined.replace(/[‘’']/g, "'");
        const normalizedSearch = newSelectedText.replace(/[‘’']/g, "'");
        idx = normalizedCombined.indexOf(normalizedSearch);
      }

      if (idx !== -1) {
        const endIdx = idx + newSelectedText.length;
        let startNode, startOffset, endNode, endOffset;
        for (let i = 0; i < offsets.length; i++) {
          const o = offsets[i];
          const nodeEnd = o.start + o.node.nodeValue.length;
          if (!startNode && idx < nodeEnd) {
            startNode = o.node;
            startOffset = idx - o.start;
          }
          if (!endNode && endIdx <= nodeEnd) {
            endNode = o.node;
            endOffset = endIdx - o.start;
          }
        }
        if (startNode && endNode) {
          freshRange = document.createRange();
          freshRange.setStart(startNode, startOffset);
          freshRange.setEnd(endNode, endOffset);
        }
      }

      if (!freshRange) {
        toast('Could not locate text — try selecting again', '');
        savedRange = null;
        closePopup();
        return;
      }

      // Step 4: wrap with new <a> — preserve auto-linked class if existed
      const wasAutoLinked = existingLink.classList.contains('auto-linked');
      const a = document.createElement('a');
      a.setAttribute('href', href2);
      a.className = wasAutoLinked ? 'citation linked auto-linked' : 'citation linked';
      freshRange.surroundContents(a);

      savedRange = null;
      closePopup();
      updateStats();
      toast(isShrink ? 'Link shrunk!' : 'Link extended!', 'success');
      setTimeout(() => showAutoSuggestPopup(a.textContent, href2), 300);
    } catch (err) {
      toast('Could not modify: ' + err.message, '');
    }
  });
  document.getElementById('extendCancelBtn').addEventListener('click', closePopup);

  const vw = window.innerWidth;
  const vh = window.innerHeight;
  popup.style.left = Math.min(x, vw - 360) + 'px';
  popup.style.top = Math.min(y, vh - 420) + 'px';
  popup.hidden = false;
  lucide.createIcons();
}

contentArea.addEventListener('mouseup', e => {
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    const selectedText = sel.toString().trim();
    const range = sel.getRangeAt(0);
    if (range.commonAncestorContainer.parentElement?.closest('.ref-block')) return;
    savedRange = range.cloneRange();
    const overlappingLink = getOverlappingLink(savedRange);
    sel.removeAllRanges();
    if (overlappingLink) {
      showExtendPopup(overlappingLink, selectedText, e.pageX, e.pageY);
    } else {
      openPopup(selectedText, e.pageX, e.pageY);
    }
  }, 100);
});

function openPopup(selectedText, x, y) {
  const m = new RegExp(CITATION_RE.source).exec(selectedText);

  popupTitle.textContent = selectedText;
  popupBody.innerHTML = '';

  // search bar
  const searchWrap = document.createElement('div');
  searchWrap.className = 'popup-search';
  searchWrap.innerHTML = `
    <i data-lucide="search"></i>
    <input type="text" id="popupSearchInput"
      placeholder="Search references..."
      autocomplete="off" spellcheck="false"/>
  `;
  popupBody.appendChild(searchWrap);

  // SECTION 1: Fuzzy matches
  let fuzzyResults = [];
  let firstLetter = '';

  if (m) {
    const surname = m[1];
    const year = m[2];
    firstLetter = stripDiacriticsAndSpecial(surname).charAt(0).toLowerCase();
    const cleanSurname = stripDiacriticsAndSpecial(surname).toLowerCase();
    let fuseResults = fuse.search(cleanSurname);
    let yearFiltered = fuseResults.filter(r => r.item.year === year);
    if (yearFiltered.length === 0) {
      const baseYear = year.replace(/[a-z]$/, '');
      yearFiltered = fuseResults.filter(r => r.item.year.replace(/[a-z]$/, '') === baseYear);
    }
    fuzzyResults = (yearFiltered.length > 0 ? yearFiltered : fuseResults).slice(0, 5);
  } else {
    const fuseText = new Fuse(refs, { keys: ['text'], threshold: 0.5, includeScore: true });
    fuzzyResults = fuseText.search(selectedText).slice(0, 5);
    firstLetter = selectedText.trim().charAt(0).toLowerCase();
  }

  // render section 1
  const sec1Label = document.createElement('div');
  sec1Label.className = 'popup-section-label';
  sec1Label.textContent = 'Fuzzy Matches';
  popupBody.appendChild(sec1Label);

  if (fuzzyResults.length === 0) {
    const none = document.createElement('div');
    none.className = 'no-matches';
    none.textContent = 'No fuzzy matches found';
    popupBody.appendChild(none);
  } else {
    fuzzyResults.forEach(r => {
      const pct = Math.round((1 - r.score) * 100);
      popupBody.appendChild(buildMatchRow(r.item, pct));
    });
  }

  // SECTION 2: All refs alphabetical, selected letter first
  const divider = document.createElement('div');
  divider.className = 'popup-section-label';
  divider.textContent = 'All References';
  popupBody.appendChild(divider);

  const sorted = [...refs].sort((a, b) => {
    const aLetter = stripDiacriticsAndSpecial(a.surname).charAt(0).toLowerCase();
    const bLetter = stripDiacriticsAndSpecial(b.surname).charAt(0).toLowerCase();
    const aMatch = aLetter === firstLetter;
    const bMatch = bLetter === firstLetter;
    if (aMatch && !bMatch) return -1;
    if (!aMatch && bMatch) return 1;
    return a.surname.localeCompare(b.surname);
  });

  sorted.forEach(ref => {
    popupBody.appendChild(buildMatchRow(ref, null));
  });

  // search filter logic
  const searchInput = document.getElementById('popupSearchInput');
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.toLowerCase().trim();
    popupBody.querySelectorAll('.match-row').forEach(row => {
      const text = row.textContent.toLowerCase();
      row.style.display = q === '' || text.includes(q) ? '' : 'none';
    });
    // hide section labels if all rows under them are hidden
    popupBody.querySelectorAll('.popup-section-label').forEach(label => {
      let next = label.nextElementSibling;
      let allHidden = true;
      while (next && !next.classList.contains('popup-section-label')) {
        if (next.style.display !== 'none') { allHidden = false; break; }
        next = next.nextElementSibling;
      }
      label.style.display = allHidden ? 'none' : '';
    });
  });
  // focus search input after popup opens
  setTimeout(() => searchInput?.focus(), 50);

  // position popup — keep inside viewport
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  popup.style.left = Math.min(x, vw - 360) + 'px';
  popup.style.top = Math.min(y, vh - 420) + 'px';
  popup.hidden = false;
  lucide.createIcons();
}

function buildMatchRow(ref, pct) {
  const row = document.createElement('div');
  row.className = 'match-row';
  row.innerHTML = `
    <div class="match-top">
      ${pct !== null ? `<span class="match-score">${pct}%</span>` : ''}
      <span class="match-author">${escapeHtml(ref.surname)}, ${escapeHtml(ref.year)}</span>
    </div>
    <div class="match-preview">${escapeHtml(ref.text.slice(0, 120))}${ref.text.length > 120 ? '…' : ''}</div>
    <button class="match-link-btn">Link It</button>
  `;
  row.querySelector('.match-link-btn').addEventListener('click', () => {
    linkCitation(ref.id);
  });
  return row;
}

function linkCitation(refId) {
  if (!savedRange) {
    toast('No text selected', '');
    return;
  }
  try {
    // check if selection spans across multiple block elements
    const startBlock = savedRange.startContainer.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6');
    const endBlock = savedRange.endContainer.parentElement?.closest('p, li, h1, h2, h3, h4, h5, h6');
    if (startBlock !== endBlock) {
      toast('Selection spans multiple paragraphs — select within one paragraph', '');
      return;
    }
    const a = document.createElement('a');
    saveUndoSnapshot(savedRange.commonAncestorContainer);
    a.setAttribute('href', '#' + refId);
    a.className = 'citation linked';
    savedRange.surroundContents(a);
    savedRange = null;
    closePopup();
    updateStats();
    manualLinkedCount++;
    updateStats();
    toast('Linked! → #' + refId, 'success');
    // delay auto suggest to avoid click event closing it immediately
    setTimeout(() => showAutoSuggestPopup(a.textContent, '#' + refId), 300);
  } catch (err) {
    toast('Could not link — try selecting simpler text: ' + err.message, '');
  }
}

popupClose.addEventListener('click', closePopup);
document.addEventListener('click', e => {
  if (!popup.hidden &&
      !popup.contains(e.target) &&
      !e.target.closest('a.citation.linked') &&
      !e.target.closest('.citation.unlinked')) {
    closePopup();
  }
});
function closePopup() {
  popup.hidden = true;
}

function findUnlinkedDuplicates(linkedText, href) {
  const results = [];
  const blocks = contentArea.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6');

  blocks.forEach(block => {
    if (block.classList.contains('ref-block') || block.closest('.ref-block')) return;

    const norm = s => s.replace(/[‘’ʼ']/g, "'");

    // build combined string from text nodes NOT inside <a> — same as linkBlockText
    const freeTextNodes = [];
    const freeWalker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement.closest('a[href]')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let freeNode;
    while ((freeNode = freeWalker.nextNode())) freeTextNodes.push(freeNode);

    let freeCombined = '';
    freeTextNodes.forEach(n => { freeCombined += n.nodeValue; });

    const normFree = norm(freeCombined);
    const normSearch = norm(linkedText);

    let occurrenceIdx = 0;
    let searchPos = 0;

    while (true) {
      const found = normFree.indexOf(normSearch, searchPos);
      if (found === -1) break;

      const start = Math.max(0, found - 40);
      const end = Math.min(freeCombined.length, found + linkedText.length + 40);
      const preview = (start > 0 ? '...' : '') +
                      freeCombined.slice(start, end) +
                      (end < freeCombined.length ? '...' : '');

      results.push({ block, preview, occurrenceIndex: occurrenceIdx });
      occurrenceIdx++;
      searchPos = found + normSearch.length;
    }
  });

  return results;
}

function linkBlockText(block, linkedText, href, occurrenceIndex = 0) {
  // find the parent element containing the unlinked text
  const norm = s => s.replace(/[‘’ʼ']/g, "'");

  // find block-level elements that contain the text
  const candidates = [block, ...block.querySelectorAll('p, span, div')];

  // collect all text nodes not inside <a> tags
  const allTextNodes = [];
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('a[href]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) allTextNodes.push(node);

  // build combined string with offsets
  let combined = '';
  const offsets = [];
  allTextNodes.forEach(n => {
    offsets.push({ node: n, start: combined.length });
    combined += n.nodeValue;
  });

  // find the Nth occurrence (occurrenceIndex) instead of always first
  let idx = -1;
  let searchFrom = 0;
  for (let i = 0; i <= occurrenceIndex; i++) {
    idx = combined.indexOf(linkedText, searchFrom);
    if (idx === -1) idx = norm(combined).indexOf(norm(linkedText), searchFrom);
    if (idx === -1) return false;
    searchFrom = idx + linkedText.length;
  }

  const endIdx = idx + linkedText.length;

  // find start and end nodes
  let startNode, startOffset, endNode, endOffset;
  for (let i = 0; i < offsets.length; i++) {
    const o = offsets[i];
    const nodeEnd = o.start + o.node.nodeValue.length;
    if (!startNode && idx < nodeEnd) {
      startNode = o.node;
      startOffset = idx - o.start;
    }
    if (!endNode && endIdx <= nodeEnd) {
      endNode = o.node;
      endOffset = endIdx - o.start;
    }
  }
  if (!startNode || !endNode) return false;

  try {
    // if start and end are in same text node — simple case
    if (startNode === endNode) {
      const range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      const a = document.createElement('a');
      a.setAttribute('href', href);
      a.className = 'citation linked auto-linked';
      range.surroundContents(a);
      return true;
    }

    // complex case — spans across inline elements like <i>
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);

    const a = document.createElement('a');
    a.setAttribute('href', href);
    a.className = 'citation linked auto-linked';

    try {
      range.surroundContents(a);
      return true;
    } catch(e2) {
      try {
        const frag = range.extractContents();
        a.appendChild(frag);
        range.insertNode(a);
        return true;
      } catch(e3) {
        return false;
      }
    }
  } catch (err) {
    return false;
  }
}

function showAutoSuggestPopup(linkedText, href) {
  const duplicates = findUnlinkedDuplicates(linkedText, href);
  if (duplicates.length === 0) return; // nothing to suggest

  // position popup center-right of screen
  const x = window.innerWidth - 380;
  const y = 80;

  popupTitle.textContent = '✨ Auto-link Suggestions';
  popupBody.innerHTML = '';

  // header info
  const info = document.createElement('div');
  info.style.cssText = 'padding:10px;font-size:12px;color:var(--text-dim);border-bottom:1px solid var(--border);';
  info.innerHTML = `Found <strong style="color:var(--accent)">${duplicates.length}</strong> more unlinked occurrence${duplicates.length > 1 ? 's' : ''} of:<br>
    <span style="font-family:var(--font-mono);font-size:11px;color:var(--text);">
      ${escapeHtml(linkedText)}
    </span>`;
  popupBody.appendChild(info);

  // individual rows
  duplicates.forEach((dup, i) => {
    const row = document.createElement('div');
    row.className = 'match-row';
    row.id = `autorow_${i}`;
    row.innerHTML = `
      <div class="match-preview">${escapeHtml(dup.preview)}</div>
      <button class="match-link-btn" style="margin-top:5px;">Link This</button>
    `;
    row.querySelector('.match-link-btn').addEventListener('click', () => {
      saveUndoSnapshot(dup.block);
      const success = linkBlockText(dup.block, linkedText, href, dup.occurrenceIndex);
      if (success) {
        row.style.opacity = '0.4';
        row.style.pointerEvents = 'none';
        row.querySelector('.match-link-btn').textContent = '✓ Linked';
        autoLinkedCount++;
        updateStats();
        toast('Auto-linked! 🟣', 'success');
        // check if all linked
        const remaining = popupBody.querySelectorAll('.match-link-btn:not([disabled])');
        if (remaining.length === 0) closePopup();
      } else {
        toast('Could not auto-link this one — select manually', '');
      }
    });
    popupBody.appendChild(row);
  });

  // Link All button
  if (duplicates.length > 1) {
    const footer = document.createElement('div');
    footer.style.cssText = 'display:flex;gap:8px;padding:10px;border-top:1px solid var(--border);';
    footer.innerHTML = `
      <button class="match-link-btn" id="autoLinkAllBtn" style="flex:1;">
        Link All (${duplicates.length})
      </button>
      <button class="match-link-btn" id="autoCloseBtn"
        style="flex:1;background:var(--bg-elev-2);color:var(--text);">
        Close
      </button>
    `;
    popupBody.appendChild(footer);

    document.getElementById('autoLinkAllBtn').addEventListener('click', () => {
      // Sort by block + occurrenceIndex so same-block items go in order
      const sorted = [...duplicates].sort((a, b) => {
        if (a.block === b.block) return a.occurrenceIndex - b.occurrenceIndex;
        return 0;
      });
      let count = 0;
      sorted.forEach(dup => {
        saveUndoSnapshot(dup.block);
        // Each link in a block shifts remaining indices in that block down by 1
        if (linkBlockText(dup.block, linkedText, href, 0)) {
          count++;
          autoLinkedCount++;
        }
      });
      updateStats();
      closePopup();
      toast(`Auto-linked ${count} citation${count > 1 ? 's' : ''}!`, 'success');
    });
    document.getElementById('autoCloseBtn').addEventListener('click', closePopup);
  } else {
    const footer = document.createElement('div');
    footer.style.cssText = 'padding:8px 10px;';
    footer.innerHTML = `
      <button class="match-link-btn" id="autoCloseBtn"
        style="width:100%;background:var(--bg-elev-2);color:var(--text);">
        Close
      </button>
    `;
    popupBody.appendChild(footer);
    document.getElementById('autoCloseBtn').addEventListener('click', closePopup);
  }

  popup.style.left = Math.min(x, window.innerWidth - 360) + 'px';
  popup.style.top = y + 'px';
  popup.hidden = false;
  lucide.createIcons();
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !popup.hidden) {
    closePopup();
  }
});

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    e.preventDefault();
    if (undoStack.length === 0) {
      toast('Nothing to undo', '');
      return;
    }
    const last = undoStack.pop();
    last.block.innerHTML = last.html;
    updateStats();
    lucide.createIcons();
    toast('Undo successful', 'success');
  }
});

function updateStats() {
  const total = manualLinkedCount + autoLinkedCount;
  document.getElementById('statTotal').textContent = total;
  document.getElementById('statLinked').textContent = manualLinkedCount;
  document.getElementById('statUnlinked').textContent = autoLinkedCount;
  document.getElementById('statRefs').textContent = refs.length;
  renderCitationSidebar();
}

function renderCitationSidebar() {
  const body = document.getElementById('linkerSidebarBody');
  const count = document.getElementById('linkerSidebarCount');
  if (!body || !count) return;

  contentArea.querySelectorAll('.linker-cite-badge').forEach(b => b.remove());

  const citations = [...contentArea.querySelectorAll('a.citation.linked')];
  count.textContent = citations.length;

  if (!citations.length) {
    body.innerHTML = '<div class="linker-sidebar-empty">No citations linked yet.</div>';
    return;
  }

  body.innerHTML = '';

  citations.forEach((a, i) => {
    const badge = document.createElement('span');
    badge.className = 'linker-cite-badge';
    badge.textContent = i + 1;
    badge.title = `Citation ${i + 1}`;
    badge.addEventListener('click', e => {
      e.stopPropagation();
      highlightSidebarCitation(i);
    });
    a.insertAdjacentElement('afterend', badge);

    const item = document.createElement('div');
    const isAuto = a.classList.contains('auto-linked');
    item.className = 'linker-citation-item' + (isAuto ? ' auto-linked' : '');
    item.dataset.index = i;

    const num = document.createElement('span');
    num.className = 'linker-citation-num';
    num.textContent = i + 1;

    const itemBody = document.createElement('div');
    itemBody.className = 'linker-citation-body';

    const text = document.createElement('div');
    text.className = 'linker-citation-text';
    text.textContent = a.textContent.trim();

    const href = document.createElement('div');
    href.className = 'linker-citation-href';
    href.textContent = a.getAttribute('href');

    const actions = document.createElement('div');
    actions.className = 'linker-citation-actions';

    const unlinkBtn = document.createElement('button');
    unlinkBtn.className = 'linker-citation-btn danger';
    unlinkBtn.textContent = 'Unlink';
    unlinkBtn.addEventListener('click', e => {
      e.stopPropagation();
      saveUndoSnapshot(a);
      const isAutoLinked = a.classList.contains('auto-linked');
      const textNode = document.createTextNode(a.textContent);
      a.replaceWith(textNode);
      if (isAutoLinked) {
        autoLinkedCount = Math.max(0, autoLinkedCount - 1);
      } else {
        manualLinkedCount = Math.max(0, manualLinkedCount - 1);
      }
      updateStats();
      toast('Citation unlinked', 'success');
    });

    item.addEventListener('click', () => {
      highlightSidebarCitation(i);
      a.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    actions.appendChild(unlinkBtn);
    itemBody.appendChild(text);
    itemBody.appendChild(href);
    itemBody.appendChild(actions);
    item.appendChild(num);
    item.appendChild(itemBody);
    body.appendChild(item);
  });
}

function highlightSidebarCitation(index) {
  document.querySelectorAll('.linker-citation-item').forEach(el => {
    el.classList.remove('highlighted');
  });
  const target = document.querySelector(`.linker-citation-item[data-index="${index}"]`);
  if (target) {
    target.classList.add('highlighted');
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

exportBtn.addEventListener('click', () => {
  try {
    exportXHTML();
    toast('Export complete', 'success');
  } catch (err) {
    toast(`Export failed: ${err.message}`);
  }
});

document.getElementById('copyBtn').addEventListener('click', async () => {
  try {
    const serialized = buildSerializedExport();

    await navigator.clipboard.writeText(serialized);

    // visual feedback — change button text briefly
    const copyBtn = document.getElementById('copyBtn');
    const original = copyBtn.innerHTML;
    copyBtn.innerHTML = '<i data-lucide="check"></i> Copied!';
    copyBtn.style.borderColor = 'var(--green)';
    copyBtn.style.color = 'var(--green)';
    lucide.createIcons();
    setTimeout(() => {
      copyBtn.innerHTML = original;
      copyBtn.style.borderColor = '';
      copyBtn.style.color = '';
      lucide.createIcons();
    }, 2000);

    toast('XHTML copied to clipboard', 'success');
  } catch (err) {
    toast('Copy failed: ' + err.message);
  }
});

// Returns combined text of all text nodes NOT inside <a> tags in a block
function getFreeText(block) {
  let text = '';
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.parentElement.closest('a[href]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }
  });
  let node;
  while ((node = walker.nextNode())) text += node.nodeValue;
  return text;
}

function runAutoLink() {
  if (!refs.length) { toast('Load a file first', ''); return; }

  const autoLinkBtn = document.getElementById('autoLinkBtn');
  if (autoLinkBtn) { autoLinkBtn.disabled = true; autoLinkBtn.textContent = 'Linking...'; }

  let linkedCount = 0;

  const blocks = [...contentArea.querySelectorAll('p, li, h1, h2, h3, h4, h5, h6')]
    .filter(el => !el.classList.contains('ref-block') && !el.closest('.ref-block'));

  const patternMap = [];
  refs.forEach(ref => {
    const patterns = buildSearchPatterns(ref);
    const href = '#' + ref.id;
    patterns.forEach(p => patternMap.push({ pattern: p, href }));
  });
  patternMap.sort((a, b) => b.pattern.length - a.pattern.length);

  // PASS 1: Direct pattern matching for all blocks
  // Recompute free text after each successful link to avoid stale DOM reads
  blocks.forEach(block => {
    patternMap.forEach(({ pattern, href }) => {
      const normPattern = normalizeForSearch(pattern);
      if (!normPattern || !/\d{4}/.test(normPattern)) return;

      const blockFreeText = normalizeForSearch(getFreeText(block));
      if (!blockFreeText.includes(normPattern)) return;

      if (block.querySelector(`a[href="${href}"]`)) return;

      saveUndoSnapshot(block);
      const success = linkBlockText(block, normPattern, href, 0);
      if (success) {
        linkedCount++;
        autoLinkedCount++;
      }
    });
  });

  // PASS 2: Semicolon multi-citation splitting
  blocks.forEach(block => {
    const freeText = normalizeForSearch(getFreeText(block));
    const bracketRe = /\(([^)]*;[^)]*)\)/g;
    let m;
    while ((m = bracketRe.exec(freeText)) !== null) {
      const parts = m[1].split(';').map(s => s.trim());
      parts.forEach(part => {
        for (const { pattern, href } of patternMap) {
          const normPattern = normalizeForSearch(pattern);
          if (!normPattern || !/\d{4}/.test(normPattern)) continue;
          if (!part.includes(normPattern)) continue;
          if (block.querySelector(`a[href="${href}"]`)) continue;

          saveUndoSnapshot(block);
          const success = linkBlockText(block, normPattern, href, 0);
          if (success) {
            linkedCount++;
            autoLinkedCount++;
          }
          break;
        }
      });
    }
  });

  updateStats();
  renderCitationSidebar();

  if (autoLinkBtn) {
    autoLinkBtn.disabled = false;
    autoLinkBtn.innerHTML = '<i data-lucide="zap"></i> Auto Link';
    lucide.createIcons();
  }

  linkedCount === 0
    ? toast('No new citations found to auto-link', '')
    : toast(`Auto-linked ${linkedCount} citation${linkedCount !== 1 ? 's' : ''}`, 'success');
}

document.getElementById('autoLinkBtn').addEventListener('click', runAutoLink);

document.getElementById('compareBtn').addEventListener('click', () => {
  // auto-fill left with original, right with exported
  document.getElementById('compareLeft').value = originalRawText;
  document.getElementById('compareRight').value = buildSerializedExport();

  // switch to compare tab
  switchTab('compare');

  // run diff automatically
  runCompare();
});

document.getElementById('runCompareBtn').addEventListener('click', runCompare);

function highlightTag(tag) {
  if (tag.startsWith('<?') || tag.startsWith('<!')) {
    return `<span style="color:#808080;">${tag.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`;
  }
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const nameMatch = tag.match(/^(<\/?)([a-zA-Z][a-zA-Z0-9\-:]*)/);
  if (!nameMatch) return tag.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const prefix = nameMatch[1];
  const name = nameMatch[2];
  const rest = tag.slice(prefix.length + name.length);
  const suffix = rest.endsWith('/>') ? '/>' : '>';
  const attrStr = rest.slice(0, rest.length - suffix.length);
  const attrs = attrStr.replace(/([a-zA-Z\-:]+)(=)("(?:[^"]*)")/g, (_, aName, eq, aVal) =>
    `<span style="color:#9cdcfe;">${aName}</span>${eq}<span style="color:#ce9178;">${esc(aVal)}</span>`
  );
  return `<span style="color:#569cd6;">${esc(prefix)}${name}</span>${attrs}<span style="color:#569cd6;">${esc(suffix)}</span>`;
}

function syntaxHighlight(line) {
  const tagRe = /(<\?[^?]*\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/[a-zA-Z][a-zA-Z0-9\-:]*>|<[a-zA-Z][a-zA-Z0-9\-:]*(?:\s[^>]*)?\/?>)/g;
  const result = [];
  let last = 0, m;
  while ((m = tagRe.exec(line)) !== null) {
    if (m.index > last) {
      result.push(`<span style="color:#d4d4d4;">${line.slice(last, m.index).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`);
    }
    result.push(highlightTag(m[0]));
    last = m.index + m[0].length;
  }
  if (last < line.length) {
    result.push(`<span style="color:#d4d4d4;">${line.slice(last).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</span>`);
  }
  return result.join('') || ' ';
}

function wordLevelDiff(oldLine, newLine) {
  const parts = Diff.diffWords(oldLine, newLine);
  let oldHtml = '', newHtml = '';
  parts.forEach(part => {
    const esc = part.value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    if (part.removed) {
      oldHtml += `<mark style="background:#f0503f55;color:#f48771;border-radius:2px;">${esc}</mark>`;
    } else if (part.added) {
      newHtml += `<mark style="background:#3ecf8e55;color:#89d185;border-radius:2px;">${esc}</mark>`;
    } else {
      const highlighted = syntaxHighlight(part.value);
      oldHtml += highlighted;
      newHtml += highlighted;
    }
  });
  return { oldHtml, newHtml };
}

function runCompare() {
  const left = document.getElementById('compareLeft').value;
  const right = document.getElementById('compareRight').value;

  if (!left.trim() && !right.trim()) {
    document.getElementById('diffOutput').innerHTML = `
      <div style="text-align:center;color:#858585;padding:40px;font-size:13px;">
        Paste HTML in both boxes and click Run Compare
      </div>`;
    return;
  }

  const diffResult = Diff.diffLines(left, right);
  const leftRows = [];
  const rightRows = [];
  let leftLineNum = 1;
  let rightLineNum = 1;

  const ROW = (bg, numColor, num, content) =>
    `<div style="display:flex;min-height:22px;background:${bg};">
      <span style="min-width:48px;padding:2px 10px 2px 0;color:${numColor};text-align:right;user-select:none;font-size:11px;line-height:18px;border-right:1px solid #2a2d2e;flex-shrink:0;">${num}</span>
      <span style="padding:2px 12px;white-space:pre-wrap;word-break:break-word;font-size:12px;line-height:18px;flex:1;">${content}</span>
    </div>`;
  const EMPTY = () => ROW('#181818', '#333', '', ' ');

  diffResult.forEach((part, idx) => {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();

    if (part.removed) {
      const nextPart = diffResult[idx + 1];
      const addedLines = (nextPart && nextPart.added)
        ? nextPart.value.split('\n').filter((l, i, a) => !(i === a.length - 1 && l === ''))
        : [];

      lines.forEach((line, li) => {
        if (addedLines[li] !== undefined) {
          const { oldHtml, newHtml } = wordLevelDiff(line, addedLines[li]);
          leftRows.push(ROW('#2b1a1a', '#f44747', leftLineNum++, oldHtml));
          rightRows.push(ROW('#1a2b1a', '#4ec94e', rightLineNum++, newHtml));
        } else {
          leftRows.push(ROW('#2b1a1a', '#f44747', leftLineNum++, syntaxHighlight(line)));
          rightRows.push(EMPTY());
        }
      });
      if (addedLines.length > lines.length) {
        addedLines.slice(lines.length).forEach(line => {
          leftRows.push(EMPTY());
          rightRows.push(ROW('#1a2b1a', '#4ec94e', rightLineNum++, syntaxHighlight(line)));
        });
      }
    } else if (part.added) {
      const prevPart = diffResult[idx - 1];
      if (prevPart && prevPart.removed) return;
      lines.forEach(line => {
        leftRows.push(EMPTY());
        rightRows.push(ROW('#1a2b1a', '#4ec94e', rightLineNum++, syntaxHighlight(line)));
      });
    } else {
      lines.forEach(line => {
        const highlighted = syntaxHighlight(line);
        leftRows.push(ROW('#1e1e1e', '#858585', leftLineNum++, highlighted));
        rightRows.push(ROW('#1e1e1e', '#858585', rightLineNum++, highlighted));
      });
    }
  });

  const changedIndices = [];
  leftRows.forEach((html, i) => {
    if (html.includes('#2b1a1a') || html.includes('#1a2b1a')) changedIndices.push(i);
  });
  const changeGroups = [];
  changedIndices.forEach(i => {
    if (!changeGroups.length || i > changeGroups[changeGroups.length - 1] + 1) changeGroups.push(i);
  });
  let currentGroup = -1;

  function panel(rows, label) {
    return `<div style="flex:1;display:flex;flex-direction:column;border:1px solid #2a2d2e;border-radius:6px;min-width:0;overflow:hidden;">
      <div style="background:#252526;padding:7px 14px;font-size:11px;color:#cccccc;border-bottom:1px solid #2a2d2e;font-family:var(--font-mono);flex-shrink:0;">${label}</div>
      <div class="diff-panel-body" style="overflow:auto;background:#1e1e1e;font-family:var(--font-mono);">${rows.join('')}</div>
    </div>`;
  }

  const diffOut = document.getElementById('diffOutput');
  diffOut.innerHTML = `
    <div class="diff-nav">
      <span class="diff-nav-info" id="diffNavInfo">${changeGroups.length} change${changeGroups.length !== 1 ? 's' : ''}</span>
      <button class="diff-nav-btn" id="diffPrevBtn">↑ Prev</button>
      <button class="diff-nav-btn" id="diffNextBtn">↓ Next</button>
    </div>
    <div class="diff-panels">${panel(leftRows, 'Original')}${panel(rightRows, 'Modified')}</div>`;

  const panels = diffOut.querySelectorAll('.diff-panel-body');
  const [leftPanel, rightPanel] = panels;
  let syncing = false;
  leftPanel.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    rightPanel.scrollTop = leftPanel.scrollTop;
    rightPanel.scrollLeft = leftPanel.scrollLeft;
    syncing = false;
  });
  rightPanel.addEventListener('scroll', () => {
    if (syncing) return; syncing = true;
    leftPanel.scrollTop = rightPanel.scrollTop;
    leftPanel.scrollLeft = rightPanel.scrollLeft;
    syncing = false;
  });

  function scrollToGroup(idx) {
    if (!changeGroups.length) return;
    currentGroup = idx;
    const allRows = Array.from(leftPanel.children);
    const target = allRows[changeGroups[currentGroup]];
    if (target) {
      target.scrollIntoView({ block: 'center' });
      target.style.outline = '2px solid var(--accent)';
      setTimeout(() => { target.style.outline = ''; }, 1000);
    }
    document.getElementById('diffNavInfo').textContent =
      `${currentGroup + 1} / ${changeGroups.length} change${changeGroups.length !== 1 ? 's' : ''}`;
  }

  // auto jump to first change
  if (changeGroups.length) scrollToGroup(0);

  document.getElementById('diffNextBtn').addEventListener('click', () => {
    if (!changeGroups.length) return;
    if (currentGroup >= changeGroups.length - 1) return;
    scrollToGroup(currentGroup + 1);
  });
  document.getElementById('diffPrevBtn').addEventListener('click', () => {
    if (!changeGroups.length) return;
    if (currentGroup <= 0) return;
    scrollToGroup(currentGroup - 1);
  });
}


function buildSerializedExport() {
  let output = originalRawText;

  const newLinks = [];
  contentArea.querySelectorAll('a.citation[href^="#"]').forEach(a => {
    newLinks.push({
      href: a.getAttribute('href'),
      text: a.textContent
    });
  });

  newLinks.sort((a, b) => b.text.length - a.text.length);

  newLinks.forEach(({ href, text }) => {
    const pattern = text.split('').map(ch => {
      if (/\s/.test(ch)) return '\\s+';
      if (/[a-zA-Z0-9]/.test(ch)) return ch;
      const code = ch.charCodeAt(0);
      const esc = ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const hex = code.toString(16);
      return `(?:${esc}|&#${code};|&#x0*${hex};)`;
    }).join('');

    const re = new RegExp(pattern, 'g');
    let m;
    while ((m = re.exec(output)) !== null) {
      const matchStart = m.index;
      const matchEnd = matchStart + m[0].length;
      const before = output.slice(0, matchStart);

      // CRITICAL: skip if match is inside an XML/HTML tag (between < and >)
      const lastOpen = before.lastIndexOf('<');
      const lastClose = before.lastIndexOf('>');
      if (lastOpen > lastClose) continue; // inside a tag

      // skip if inside a ref block
      const refOpenRe = /<p[^>]+class="[^"]*\bref\b[^"]*"/g;
      let lastRefOpen = -1, rm;
      while ((rm = refOpenRe.exec(before)) !== null) lastRefOpen = rm.index;
      const lastRefClose = before.lastIndexOf('</p>');
      if (lastRefOpen !== -1 && lastRefOpen > lastRefClose) continue;

      // skip if already inside an <a href> link
      const openLinks = (before.match(/<a\s[^>]*href[^>]*(?<!\/)>/g) || []).length;
      const closeLinks = (before.match(/<\/a>/g) || []).length;
      if (openLinks > closeLinks) continue;

      output = output.slice(0, matchStart) +
               `<a href="${href}">` + m[0] + `</a>` +
               output.slice(matchEnd);
      break;
    }
  });

  return output;
}

function exportXHTML() {
  const serialized = buildSerializedExport();

  const blob = new Blob([serialized], { type: 'application/xhtml+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName || 'linked.xhtml';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i data-lucide="${type === 'success' ? 'check-circle' : 'alert-circle'}"></i><span>${escapeHtml(msg)}</span>`;
  toastContainer.appendChild(el);
  lucide.createIcons();
  setTimeout(() => el.remove(), 3500);
}

// theme
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.setAttribute('data-theme', savedTheme);
updateThemeIcon();

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  updateThemeIcon();
});

function updateThemeIcon() {
  const icon = themeToggle.querySelector('i, svg');
  const current = document.documentElement.getAttribute('data-theme');
  const name = current === 'light' ? 'sun' : 'moon';
  const replacement = document.createElement('i');
  replacement.setAttribute('data-lucide', name);
  icon.replaceWith(replacement);
  lucide.createIcons();
}
