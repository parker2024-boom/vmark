// @ts-check
/**
 * VMark Reader - Interactive controls for exported HTML
 *
 * Features: font size / line height / content width, themes, CJK spacing,
 * table of contents, code block buttons, image lightbox, footnote navigation.
 * Settings persist in localStorage.
 *
 * This file ships verbatim inside every exported document, so it is a classic
 * script with no imports. It is type-checked through its JSDoc and linted;
 * `__tests__/readerStaticChecks.test.ts` fails if either stops being true.
 * The DOM it reads is the exporter's: footnotes are
 * `sup[data-type="footnote_reference"]` and `dl[data-type="footnote_definition"]`,
 * joined by `data-label`.
 */

(function() {
  'use strict';

  /**
   * @typedef {{ background: string, foreground: string, secondary: string, border: string, link: string, isDark: boolean }} Theme
   * @typedef {'fontSize' | 'lineHeight' | 'contentWidth' | 'cjkLetterSpacing'} RangeSetting
   * @typedef {'cjkLatinSpacing' | 'expandDetails' | 'showToc'} ToggleSetting
   * @typedef {'latinFont' | 'cjkFont' | 'theme'} NameSetting
   */

  /** First HTML element matching `selector` under `root`. @param {string} selector @param {ParentNode} [root] @returns {HTMLElement | null} */
  function qs(selector, root) {
    const el = (root || document).querySelector(selector);
    return el instanceof HTMLElement ? el : null;
  }

  /** Every HTML element matching `selector` under `root`. @param {string} selector @param {ParentNode} [root] @returns {HTMLElement[]} */
  function qsa(selector, root) {
    /** @type {HTMLElement[]} */
    const found = [];
    (root || document).querySelectorAll(selector).forEach(el => {
      if (el instanceof HTMLElement) found.push(el);
    });
    return found;
  }

  /** Own-property lookup, so a name like "constructor" is not found on the prototype. @template T @param {Record<string, T>} table @param {string} key @returns {T | undefined} */
  function own(table, key) {
    return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
  }

  /** 'smooth', unless the reader asked the system for reduced motion. @returns {ScrollBehavior} */
  function scrollBehavior() {
    const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    return reduced ? 'auto' : 'smooth';
  }

  // Font stacks (matching VMark editor fonts)
  /** @type {{ latin: Record<string, string>, cjk: Record<string, string> }} */
  const FONT_STACKS = {
    latin: {
      system: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      athelas: "Athelas, Georgia, serif",
      palatino: "Palatino, 'Palatino Linotype', serif",
      georgia: "Georgia, 'Times New Roman', serif",
      charter: "Charter, Georgia, serif",
      literata: "Literata, Georgia, serif"
    },
    cjk: {
      system: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
      pingfang: '"PingFang SC", "PingFang TC", sans-serif',
      songti: '"Songti SC", "STSong", "SimSun", serif',
      kaiti: '"Kaiti SC", "STKaiti", "KaiTi", serif',
      notoserif: '"Noto Serif CJK SC", "Source Han Serif SC", serif',
      sourcehans: '"Source Han Sans SC", "Noto Sans CJK SC", sans-serif'
    }
  };

  // Font options for UI
  const FONT_OPTIONS = {
    latin: [
      { value: 'system', label: 'System' },
      { value: 'athelas', label: 'Athelas' },
      { value: 'palatino', label: 'Palatino' },
      { value: 'georgia', label: 'Georgia' },
      { value: 'charter', label: 'Charter' },
      { value: 'literata', label: 'Literata' }
    ],
    cjk: [
      { value: 'system', label: 'System' },
      { value: 'pingfang', label: 'PingFang' },
      { value: 'songti', label: 'Songti' },
      { value: 'kaiti', label: 'Kaiti' },
      { value: 'notoserif', label: 'Noto Serif' },
      { value: 'sourcehans', label: 'Source Han' }
    ]
  };

  // Theme definitions (matching VMark editor themes)
  /** @type {Record<string, Theme>} */
  const THEMES = {
    white: {
      background: '#FFFFFF',
      foreground: '#1a1a1a',
      secondary: '#f8f8f8',
      border: '#eeeeee',
      link: '#0066cc',
      isDark: false
    },
    paper: {
      background: '#EEEDED',
      foreground: '#1a1a1a',
      secondary: '#e5e4e4',
      border: '#d5d4d4',
      link: '#0066cc',
      isDark: false
    },
    mint: {
      background: '#CCE6D0',
      foreground: '#2d3a35',
      secondary: '#b8d9bd',
      border: '#a8c9ad',
      link: '#1a6b4a',
      isDark: false
    },
    sepia: {
      background: '#F9F0DB',
      foreground: '#5c4b37',
      secondary: '#f0e5cc',
      border: '#e0d5bc',
      link: '#8b4513',
      isDark: false
    },
    night: {
      background: '#23262b',
      foreground: '#d6d9de',
      secondary: '#2a2e34',
      border: '#3a3f46',
      link: '#5aa8ff',
      isDark: true
    }
  };

  // Default settings
  const DEFAULTS = {
    fontSize: 18,
    lineHeight: 1.6,
    contentWidth: 50,
    latinFont: 'system',
    cjkFont: 'system',
    cjkLetterSpacing: 0.05,
    theme: 'paper',
    cjkLatinSpacing: true,
    expandDetails: false,
    showToc: false
  };

  // Settings bounds
  /** @type {Record<RangeSetting, { min: number, max: number, step: number }>} */
  const BOUNDS = {
    fontSize: { min: 12, max: 28, step: 1 },
    lineHeight: { min: 1.2, max: 2.4, step: 0.1 },
    contentWidth: { min: 30, max: 80, step: 5 },
    cjkLetterSpacing: { min: 0.02, max: 0.12, step: 0.01 }
  };

  // Storage key
  const STORAGE_KEY = 'vmark-reader-settings';

  /** @type {RangeSetting[]} */
  const RANGE_SETTINGS = ['fontSize', 'lineHeight', 'contentWidth', 'cjkLetterSpacing'];
  /** @type {ToggleSetting[]} */
  const TOGGLE_SETTINGS = ['cjkLatinSpacing', 'expandDetails', 'showToc'];
  /** @type {NameSetting[]} */
  const NAME_SETTINGS = ['latinFont', 'cjkFont', 'theme'];

  // State
  let settings = { ...DEFAULTS };
  /** @type {HTMLElement | null} */
  let panel = null;
  let isOpen = false;

  /** @param {unknown} name @returns {name is RangeSetting} */
  function isRangeSetting(name) {
    return RANGE_SETTINGS.some(key => key === name);
  }

  /** Clamp to the setting's bounds and round away float noise. @param {RangeSetting} key @param {number} value */
  function clampSetting(key, value) {
    const bounds = BOUNDS[key];
    const precision = bounds.step < 0.1 ? 100 : 10;
    return Math.round(Math.max(bounds.min, Math.min(bounds.max, value)) * precision) / precision;
  }

  /**
   * Load settings from localStorage. Stored values are untrusted — any page on
   * this origin can write them, and some are rendered into the panel — so each
   * is taken only if it has its default's type; numbers are clamped.
   */
  function loadSettings() {
    try {
      /** @type {unknown} */
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (typeof parsed !== 'object' || parsed === null) return;
      const saved = /** @type {Record<string, unknown>} */ (parsed);
      RANGE_SETTINGS.forEach(key => {
        const value = saved[key];
        if (typeof value === 'number' && Number.isFinite(value)) settings[key] = clampSetting(key, value);
      });
      TOGGLE_SETTINGS.forEach(key => {
        const value = saved[key];
        if (typeof value === 'boolean') settings[key] = value;
      });
      NAME_SETTINGS.forEach(key => {
        const value = saved[key];
        if (typeof value === 'string') settings[key] = value;
      });
    } catch (e) {
      console.warn('[VMark Reader] Failed to load settings:', e);
    }
  }

  /** Save settings to localStorage */
  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch (e) {
      console.warn('[VMark Reader] Failed to save settings:', e);
    }
  }

  /** Apply current settings to the document */
  function applySettings() {
    const root = document.documentElement;
    const surface = qs('.export-surface');

    // Font size
    root.style.setProperty('--editor-font-size', `${settings.fontSize}px`);
    root.style.setProperty('--editor-font-size-mono', `${settings.fontSize * 0.85}px`);

    // Line height
    root.style.setProperty('--editor-line-height', String(settings.lineHeight));
    root.style.setProperty('--editor-line-height-px', `${settings.fontSize * settings.lineHeight}px`);

    // Fonts
    const latinStack = own(FONT_STACKS.latin, settings.latinFont) || FONT_STACKS.latin.system;
    const cjkStack = own(FONT_STACKS.cjk, settings.cjkFont) || FONT_STACKS.cjk.system;
    root.style.setProperty('--font-sans', `${latinStack}, ${cjkStack}`);

    // Content width
    if (surface) {
      surface.style.maxWidth = `${settings.contentWidth}em`;
    }

    // CJK letter spacing (applied dynamically to text)
    applyCjkLetterSpacing();

    // Theme
    applyTheme(settings.theme);

    // CJK spacing (handles both apply and remove based on setting)
    applyCjkSpacing();

    // Expand details
    applyExpandDetails();

    // Table of Contents
    applyToc();

    // Code block buttons (copy, line numbers toggle)
    applyCodeBlockButtons();

    // Update UI if panel exists
    updatePanelUI();
  }

  /** Apply theme colors to the document. @param {string} themeId */
  function applyTheme(themeId) {
    const theme = own(THEMES, themeId) || THEMES.paper;
    const root = document.documentElement;

    // Apply theme colors as CSS variables
    root.style.setProperty('--bg-color', theme.background);
    root.style.setProperty('--text-color', theme.foreground);
    root.style.setProperty('--bg-secondary', theme.secondary);
    root.style.setProperty('--border-color', theme.border);
    root.style.setProperty('--primary-color', theme.link);

    // Code block colors
    root.style.setProperty('--code-bg-color', theme.secondary);
    root.style.setProperty('--code-text-color', theme.foreground);
    root.style.setProperty('--code-border-color', theme.border);

    // Text secondary (slightly muted)
    if (theme.isDark) {
      root.style.setProperty('--text-secondary', '#858585');
      root.style.setProperty('--text-tertiary', '#6b7078');
      root.style.setProperty('--hover-bg', 'rgba(255, 255, 255, 0.06)');
      document.documentElement.classList.add('dark-theme');
    } else {
      root.style.setProperty('--text-secondary', '#666666');
      root.style.setProperty('--text-tertiary', '#999999');
      root.style.setProperty('--hover-bg', 'rgba(0, 0, 0, 0.04)');
      document.documentElement.classList.remove('dark-theme');
    }

    // Update body background
    document.body.style.backgroundColor = theme.background;
  }

  // Store original text for CJK spacing toggle
  /** @type {WeakMap<Node, string>} */
  const originalTexts = new WeakMap();
  const THIN_SPACE = '\u2009';
  const SKIPPED_TEXT_TAGS = ['script', 'style', 'code', 'pre', 'kbd', 'samp'];
  const BLOCK_SELECTOR = 'p, li, td, th, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, summary, figcaption, pre, div';

  /** True for text the reader may respace: not code, not script or style. @param {Node} node */
  function isProseText(node) {
    const parent = node.parentElement;
    return !!parent && !SKIPPED_TEXT_TAGS.includes(parent.tagName.toLowerCase());
  }

  /** Every text node under `root`, in document order. @param {Node} root @returns {Node[]} */
  function textNodesOf(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    /** @type {Node[]} */
    const nodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
    return nodes;
  }

  /** Apply or remove CJK-Latin spacing */
  function applyCjkSpacing() {
    const editor = qs('.export-surface-editor');
    if (!editor) return;

    const isApplied = editor.dataset.cjkApplied === 'true';

    if (settings.cjkLatinSpacing && !isApplied) {
      addCjkSpacing(editor);
      editor.dataset.cjkApplied = 'true';
    } else if (!settings.cjkLatinSpacing && isApplied) {
      removeCjkSpacing(editor);
      editor.dataset.cjkApplied = 'false';
    }
  }

  /** Replace a text node's content, remembering what it was. @param {Node} node @param {string} text */
  function respace(node, text) {
    if (!originalTexts.has(node)) originalTexts.set(node, node.textContent || '');
    node.textContent = text;
  }

  /**
   * Put a thin space at every CJK/Latin boundary. A boundary can fall BETWEEN
   * two text nodes — CJK letter spacing wraps each CJK run in its own span —
   * so the previous text node of the same block is part of the comparison.
   * The space always goes on the Latin side, keeping the CJK spans pure.
   * @param {HTMLElement} editor
   */
  function addCjkSpacing(editor) {
    const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\u3000-\u303f\uff00-\uffef\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/;
    const LATIN_RANGE = /[a-zA-Z0-9]/;
    /** @param {string} a @param {string} b */
    const needsSpace = (a, b) =>
      (CJK_RANGE.test(a) && LATIN_RANGE.test(b)) || (LATIN_RANGE.test(a) && CJK_RANGE.test(b));
    /** @param {Node} node */
    const blockOf = node => (node.parentElement ? node.parentElement.closest(BLOCK_SELECTOR) : null);

    /** @type {Node | null} The previous non-empty text node, when it is prose. */
    let previous = null;
    textNodesOf(editor).forEach(textNode => {
      const text = textNode.textContent || '';
      if (!text) return;
      if (!isProseText(textNode)) {
        previous = null;
        return;
      }

      let result = '';
      for (let i = 0; i < text.length; i++) {
        result += text[i];
        if (i < text.length - 1 && needsSpace(text[i], text[i + 1])) result += THIN_SPACE;
      }

      const before = previous ? previous.textContent || '' : '';
      if (previous && before && blockOf(previous) === blockOf(textNode) && needsSpace(before[before.length - 1], text[0])) {
        if (LATIN_RANGE.test(text[0])) result = THIN_SPACE + result;
        else respace(previous, before + THIN_SPACE);
      }

      if (result !== text) respace(textNode, result);
      previous = textNode;
    });
  }

  /** @param {HTMLElement} editor */
  function removeCjkSpacing(editor) {
    textNodesOf(editor).filter(isProseText).forEach(textNode => {
      // Restore original or remove thin spaces
      const original = originalTexts.get(textNode);
      if (original !== undefined) {
        textNode.textContent = original;
      } else {
        // Fallback: remove all thin spaces
        textNode.textContent = (textNode.textContent || '').replace(/\u2009/g, '');
      }
    });
  }

  /** Apply CJK letter spacing by wrapping CJK text in spans */
  function applyCjkLetterSpacing() {
    const editor = qs('.export-surface-editor');
    if (!editor) return;

    const spacing = settings.cjkLetterSpacing;
    const spacingValue = spacing === 0 ? '0' : `${spacing}em`;

    // Update existing cjk-spacing spans
    qsa('.cjk-letter-spacing', editor).forEach(span => {
      span.style.letterSpacing = spacingValue;
    });

    // If already processed, just update values
    if (editor.dataset.cjkLetterSpacingApplied === 'true') {
      return;
    }

    // CJK Unicode ranges
    const CJK_REGEX = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af\u3100-\u312f]+/g;

    // Skip code, pre, and already-processed spans
    const textNodes = textNodesOf(editor).filter(node =>
      isProseText(node) && !(node.parentElement && node.parentElement.classList.contains('cjk-letter-spacing')));

    textNodes.forEach(textNode => {
      const text = textNode.textContent;
      if (!text) return;

      CJK_REGEX.lastIndex = 0;
      const matches = [];
      let match;
      while ((match = CJK_REGEX.exec(text)) !== null) {
        matches.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
      }

      if (matches.length === 0) return;

      // Create document fragment with wrapped CJK runs
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;

      matches.forEach(m => {
        // Add text before match
        if (m.start > lastIndex) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, m.start)));
        }
        // Add wrapped CJK text
        const span = document.createElement('span');
        span.className = 'cjk-letter-spacing';
        span.style.letterSpacing = spacingValue;
        span.textContent = m.text;
        fragment.appendChild(span);
        lastIndex = m.end;
      });

      // Add remaining text
      if (lastIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
      }

      // Replace text node with fragment
      if (textNode.parentNode) textNode.parentNode.replaceChild(fragment, textNode);
    });

    editor.dataset.cjkLetterSpacingApplied = 'true';
  }

  /** Apply expand/collapse all details */
  function applyExpandDetails() {
    const details = document.querySelectorAll('details');
    details.forEach(el => {
      if (settings.expandDetails) {
        el.setAttribute('open', '');
      } else {
        el.removeAttribute('open');
      }
    });
  }

  /** Apply code block buttons (copy, line numbers toggle) */
  function applyCodeBlockButtons() {
    const editor = qs('.export-surface-editor');
    if (!editor) return;

    // Only add buttons once
    if (editor.dataset.codeButtonsApplied === 'true') return;

    // Exclude preview-only blocks (mermaid, math) which show rendered output
    const codeBlocks = qsa('.code-block-wrapper:not(.code-block-preview-only)', editor);
    codeBlocks.forEach(wrapper => {
      // Create button container
      const btnContainer = document.createElement('div');
      btnContainer.className = 'vmark-code-btn-group';

      // Line numbers toggle button (only if block has line numbers)
      const lineNumbers = qs('.code-line-numbers', wrapper);
      if (lineNumbers) {
        // Hide line numbers by default
        lineNumbers.style.display = 'none';

        const lineNumBtn = document.createElement('button');
        lineNumBtn.className = 'vmark-code-btn';
        lineNumBtn.title = 'Show line numbers';
        lineNumBtn.setAttribute('aria-label', 'Show line numbers');
        lineNumBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="4" y1="6" x2="4" y2="6.01"></line>
          <line x1="4" y1="12" x2="4" y2="12.01"></line>
          <line x1="4" y1="18" x2="4" y2="18.01"></line>
          <line x1="9" y1="6" x2="20" y2="6"></line>
          <line x1="9" y1="12" x2="20" y2="12"></line>
          <line x1="9" y1="18" x2="20" y2="18"></line>
        </svg>`;

        lineNumBtn.addEventListener('click', () => {
          const isHidden = lineNumbers.style.display === 'none';
          lineNumbers.style.display = isHidden ? 'flex' : 'none';
          const label = isHidden ? 'Hide line numbers' : 'Show line numbers';
          lineNumBtn.title = label;
          lineNumBtn.setAttribute('aria-label', label);
        });

        btnContainer.appendChild(lineNumBtn);
      }

      // Copy button
      const copyBtn = document.createElement('button');
      copyBtn.className = 'vmark-code-btn';
      copyBtn.title = 'Copy code';
      copyBtn.setAttribute('aria-label', 'Copy code');
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>`;

      copyBtn.addEventListener('click', () => {
        const pre = wrapper.querySelector('pre');
        if (!pre) return;

        const code = pre.textContent || '';
        navigator.clipboard.writeText(code).then(() => {
          // Show success feedback
          copyBtn.classList.add('copied');
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>`;

          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
            </svg>`;
          }, 2000);
        }).catch(err => {
          console.warn('[VMark Reader] Copy failed:', err);
        });
      });

      btnContainer.appendChild(copyBtn);
      wrapper.appendChild(btnContainer);
    });

    editor.dataset.codeButtonsApplied = 'true';
  }

  // TOC state
  /** @type {HTMLElement | null} */
  let tocSidebar = null;
  /** @type {HTMLElement | null} */
  let tocBackdrop = null;
  /** @type {HTMLElement | null} */
  let tocToggleTab = null;
  /** @type {{ id: string, level: number, text: string, element: HTMLElement }[]} */
  let tocHeadings = [];
  let scrollSpyActive = false;

  /** Toggle TOC visibility */
  function toggleToc() {
    settings.showToc = !settings.showToc;
    saveSettings();
    applyToc();
    updatePanelUI();
  }

  /** Create TOC toggle tab (always visible on left edge) */
  function createTocToggleTab() {
    if (tocToggleTab) return;

    const tab = document.createElement('button');
    tab.className = 'vmark-toc-toggle-tab';
    tab.setAttribute('aria-label', 'Toggle Table of Contents');
    tab.title = 'Table of Contents (T)';

    // Create chevron SVG using DOM methods (avoid innerHTML for security hygiene)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('fill', 'currentColor');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.751.751 0 0 1-1.042-.018.751.751 0 0 1-.018-1.042L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z');
    svg.appendChild(path);
    tab.appendChild(svg);

    tab.addEventListener('click', toggleToc);
    document.body.appendChild(tab);
    tocToggleTab = tab;
  }

  /** Update TOC toggle tab appearance */
  function updateTocToggleTab() {
    if (!tocToggleTab) return;
    tocToggleTab.classList.toggle('expanded', settings.showToc);
  }

  /** Generate and apply Table of Contents sidebar */
  function applyToc() {
    const editor = qs('.export-surface-editor');
    const surface = qs('.export-surface');
    if (!editor || !surface) return;

    // Extract headings (h1-h3); the toggle tab exists only when there are some
    const headings = qsa('h1, h2, h3', editor);
    if (!tocToggleTab && headings.length > 0) createTocToggleTab();

    if (!settings.showToc) {
      // Hide TOC sidebar
      if (tocSidebar) {
        tocSidebar.classList.remove('visible');
        document.body.classList.remove('vmark-toc-open');
      }
      if (tocBackdrop) {
        tocBackdrop.classList.remove('visible');
      }
      updateTocToggleTab();
      disableScrollSpy();
      return;
    }

    // Show existing sidebar or create new one
    if (tocSidebar) {
      tocSidebar.classList.add('visible');
      document.body.classList.add('vmark-toc-open');
      if (tocBackdrop && window.innerWidth < 768) {
        tocBackdrop.classList.add('visible');
      }
      updateTocToggleTab();
      enableScrollSpy();
      return;
    }

    if (headings.length === 0) return;

    // Build TOC items and ensure IDs
    tocHeadings = [];
    let idCounter = 0;

    headings.forEach(heading => {
      if (!heading.id) {
        heading.id = `heading-${++idCounter}`;
      }

      tocHeadings.push({
        id: heading.id,
        level: parseInt(heading.tagName[1], 10),
        text: (heading.textContent || '').trim(),
        element: heading
      });
    });

    // Create sidebar
    const sidebar = document.createElement('aside');
    sidebar.className = 'vmark-toc-sidebar visible';

    // Header with close button (for mobile only)
    const header = document.createElement('div');
    header.className = 'vmark-toc-header';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'vmark-toc-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '\u00d7';
    header.appendChild(closeBtn);
    sidebar.appendChild(header);

    // Navigation
    const nav = document.createElement('nav');
    nav.className = 'vmark-toc-nav';

    tocHeadings.forEach((item, index) => {
      const link = document.createElement('a');
      link.href = `#${item.id}`;
      link.className = `vmark-toc-item vmark-toc-level-${item.level}`;
      link.dataset.index = String(index);
      link.textContent = item.text;

      link.addEventListener('click', (e) => {
        e.preventDefault();
        const target = document.getElementById(item.id);
        if (target) {
          target.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
          history.pushState(null, '', `#${item.id}`);
          // On mobile, close sidebar after click
          if (window.innerWidth < 768) {
            settings.showToc = false;
            saveSettings();
            applyToc();
            updatePanelUI();
          }
        }
      });

      nav.appendChild(link);
    });

    sidebar.appendChild(nav);

    // Close button handler
    const closeToc = () => {
      settings.showToc = false;
      saveSettings();
      applyToc();
      updatePanelUI();
    };

    closeBtn.addEventListener('click', closeToc);

    // Create backdrop for mobile
    const backdrop = document.createElement('div');
    backdrop.className = 'vmark-toc-backdrop';
    backdrop.addEventListener('click', closeToc);
    document.body.appendChild(backdrop);

    // Insert sidebar
    document.body.appendChild(sidebar);
    document.body.classList.add('vmark-toc-open');

    // Show backdrop on mobile
    if (window.innerWidth < 768) {
      backdrop.classList.add('visible');
    }
    tocSidebar = sidebar;
    tocBackdrop = backdrop;

    // Enable scroll spy
    enableScrollSpy();

    // Update toggle tab state
    updateTocToggleTab();
  }

  /** Enable scroll spy to highlight current section */
  function enableScrollSpy() {
    if (scrollSpyActive || tocHeadings.length === 0) return;
    scrollSpyActive = true;
    window.addEventListener('scroll', handleScrollSpy, { passive: true });
    handleScrollSpy(); // Initial highlight
  }

  /** Disable scroll spy */
  function disableScrollSpy() {
    if (!scrollSpyActive) return;
    scrollSpyActive = false;
    window.removeEventListener('scroll', handleScrollSpy);
  }

  /** Handle scroll spy - highlight current section in TOC */
  function handleScrollSpy() {
    if (!tocSidebar || tocHeadings.length === 0) return;

    const scrollTop = window.scrollY;
    const offset = 100; // Offset from top to trigger highlight

    // Find current heading
    let currentIndex = 0;
    for (let i = tocHeadings.length - 1; i >= 0; i--) {
      const heading = tocHeadings[i].element;
      if (heading.offsetTop <= scrollTop + offset) {
        currentIndex = i;
        break;
      }
    }

    // Update active state
    const links = qsa('.vmark-toc-item', tocSidebar);
    links.forEach((link, index) => {
      link.classList.toggle('active', index === currentIndex);
    });

    // Scroll TOC to keep active item visible
    const activeLink = links[currentIndex];
    const nav = qs('.vmark-toc-nav', tocSidebar);
    if (activeLink && nav) {
      const linkRect = activeLink.getBoundingClientRect();
      const navRect = nav.getBoundingClientRect();

      if (linkRect.top < navRect.top || linkRect.bottom > navRect.bottom) {
        activeLink.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() });
      }
    }
  }

  /** Create the settings panel */
  function createPanel() {
    // Create toggle button
    const toggle = document.createElement('button');
    toggle.className = 'vmark-reader-toggle';
    toggle.setAttribute('aria-controls', 'vmark-reader-panel');
    toggle.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <circle cx="12" cy="12" r="3"/>
      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/>
    </svg>`;
    toggle.title = 'Reader Settings';
    toggle.addEventListener('click', togglePanel);

    // Create panel. Every interpolated setting is a number or a boolean
    // (see loadSettings), so none of them can carry markup.
    const el = document.createElement('div');
    el.id = 'vmark-reader-panel';
    el.className = 'vmark-reader-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Reader settings');
    el.innerHTML = `
      <div class="vmark-reader-header">
        <span>Reader Settings</span>
        <button class="vmark-reader-close" title="Close">&times;</button>
      </div>
      <div class="vmark-reader-content">
        <div class="vmark-reader-group">
          <label>Font Size</label>
          <div class="vmark-reader-range-row">
            <button class="vmark-reader-btn" data-action="fontSize" data-dir="-1">−</button>
            <span class="vmark-reader-value" data-value="fontSize">${settings.fontSize}px</span>
            <button class="vmark-reader-btn" data-action="fontSize" data-dir="1">+</button>
          </div>
        </div>
        <div class="vmark-reader-group">
          <label>Line Height</label>
          <div class="vmark-reader-range-row">
            <button class="vmark-reader-btn" data-action="lineHeight" data-dir="-1">−</button>
            <span class="vmark-reader-value" data-value="lineHeight">${settings.lineHeight}</span>
            <button class="vmark-reader-btn" data-action="lineHeight" data-dir="1">+</button>
          </div>
        </div>
        <div class="vmark-reader-group">
          <label>Content Width</label>
          <div class="vmark-reader-range-row">
            <button class="vmark-reader-btn" data-action="contentWidth" data-dir="-1">−</button>
            <span class="vmark-reader-value" data-value="contentWidth">${settings.contentWidth}em</span>
            <button class="vmark-reader-btn" data-action="contentWidth" data-dir="1">+</button>
          </div>
        </div>
        <div class="vmark-reader-group">
          <label>Latin Font</label>
          <select class="vmark-reader-select" data-setting="latinFont">
            ${FONT_OPTIONS.latin.map(o => `<option value="${o.value}" ${settings.latinFont === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="vmark-reader-group">
          <label>CJK Font</label>
          <select class="vmark-reader-select" data-setting="cjkFont">
            ${FONT_OPTIONS.cjk.map(o => `<option value="${o.value}" ${settings.cjkFont === o.value ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="vmark-reader-group">
          <label>Theme</label>
          <div class="vmark-reader-theme-row">
            <button class="vmark-reader-theme-circle ${settings.theme === 'white' ? 'active' : ''}" data-theme="white" title="White" style="background: ${THEMES.white.background}"></button>
            <button class="vmark-reader-theme-circle ${settings.theme === 'paper' ? 'active' : ''}" data-theme="paper" title="Paper" style="background: ${THEMES.paper.background}"></button>
            <button class="vmark-reader-theme-circle ${settings.theme === 'mint' ? 'active' : ''}" data-theme="mint" title="Mint" style="background: ${THEMES.mint.background}"></button>
            <button class="vmark-reader-theme-circle ${settings.theme === 'sepia' ? 'active' : ''}" data-theme="sepia" title="Sepia" style="background: ${THEMES.sepia.background}"></button>
            <button class="vmark-reader-theme-circle theme-night ${settings.theme === 'night' ? 'active' : ''}" data-theme="night" title="Night" style="background: ${THEMES.night.background}"></button>
          </div>
        </div>
        <div class="vmark-reader-group">
          <label>CJK Letter Spacing</label>
          <div class="vmark-reader-range-row">
            <button class="vmark-reader-btn" data-action="cjkLetterSpacing" data-dir="-1">−</button>
            <span class="vmark-reader-value" data-value="cjkLetterSpacing">${settings.cjkLetterSpacing}em</span>
            <button class="vmark-reader-btn" data-action="cjkLetterSpacing" data-dir="1">+</button>
          </div>
        </div>
        <div class="vmark-reader-group">
          <label class="vmark-reader-checkbox-label">
            <input type="checkbox" ${settings.cjkLatinSpacing ? 'checked' : ''} data-setting="cjkLatinSpacing">
            <span>CJK-Latin Spacing</span>
          </label>
        </div>
        <div class="vmark-reader-group">
          <label class="vmark-reader-checkbox-label">
            <input type="checkbox" ${settings.showToc ? 'checked' : ''} data-setting="showToc">
            <span>Table of Contents</span>
          </label>
        </div>
        <div class="vmark-reader-group">
          <label class="vmark-reader-checkbox-label">
            <input type="checkbox" ${settings.expandDetails ? 'checked' : ''} data-setting="expandDetails">
            <span>Expand All Sections</span>
          </label>
        </div>
        <div class="vmark-reader-group vmark-reader-reset">
          <button class="vmark-reader-reset-btn" data-action="reset">Reset to Defaults</button>
        </div>
      </div>
    `;

    // Event listeners
    qsa('.vmark-reader-close', el).forEach(btn => btn.addEventListener('click', togglePanel));
    qsa('.vmark-reader-btn', el).forEach(btn => btn.addEventListener('click', handleRangeClick));
    qsa('.vmark-reader-theme-circle', el).forEach(btn => btn.addEventListener('click', handleThemeClick));
    qsa('input[type="checkbox"]', el).forEach(box => box.addEventListener('change', handleCheckboxChange));
    qsa('.vmark-reader-select', el).forEach(select => select.addEventListener('change', handleSelectChange));
    qsa('.vmark-reader-reset-btn', el).forEach(btn => btn.addEventListener('click', handleReset));

    // Append to document
    document.body.appendChild(toggle);
    document.body.appendChild(el);
    panel = el;
    syncToggleState();
  }

  /** Toggle panel visibility */
  function togglePanel() {
    isOpen = !isOpen;
    if (panel) panel.classList.toggle('open', isOpen);
    document.body.classList.toggle('vmark-panel-open', isOpen);
    syncToggleState();
  }

  /** Tell assistive technology whether the settings panel is open. */
  function syncToggleState() {
    const toggle = qs('.vmark-reader-toggle');
    if (!toggle) return;
    toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    toggle.setAttribute('aria-label', isOpen ? 'Close reader settings' : 'Open reader settings');
  }

  /** Handle range button clicks (+/-). @param {Event} e */
  function handleRangeClick(e) {
    const btn = e.currentTarget;
    if (!(btn instanceof HTMLElement)) return;
    adjustSetting(btn.dataset.action, parseInt(btn.dataset.dir || '', 10));
  }

  /** Handle theme button clicks. @param {Event} e */
  function handleThemeClick(e) {
    const btn = e.currentTarget;
    if (!(btn instanceof HTMLElement) || !btn.dataset.theme) return;
    settings.theme = btn.dataset.theme;
    saveSettings();
    applySettings();
  }

  /** Handle checkbox changes. A checkbox may only write a boolean setting. @param {Event} e */
  function handleCheckboxChange(e) {
    const box = e.currentTarget;
    if (!(box instanceof HTMLInputElement)) return;
    const setting = TOGGLE_SETTINGS.find(key => key === box.dataset.setting);
    if (!setting) return;
    settings[setting] = box.checked;
    saveSettings();
    applySettings();
  }

  /** Handle select changes. A select may only write a font setting. @param {Event} e */
  function handleSelectChange(e) {
    const select = e.currentTarget;
    if (!(select instanceof HTMLSelectElement)) return;
    const setting = select.dataset.setting;
    if (setting !== 'latinFont' && setting !== 'cjkFont') return;
    settings[setting] = select.value;
    saveSettings();
    applySettings();
  }

  /** Handle reset button */
  function handleReset() {
    // First remove CJK spacing if applied
    const editor = qs('.export-surface-editor');
    if (editor && editor.dataset.cjkApplied === 'true') {
      removeCjkSpacing(editor);
      editor.dataset.cjkApplied = 'false';
    }

    settings = { ...DEFAULTS };
    saveSettings();
    applySettings();
  }

  /** Update panel UI to reflect current settings */
  function updatePanelUI() {
    const el = panel;
    if (!el) return;

    /** @param {RangeSetting} name @param {string} unit */
    const showValue = (name, unit) => {
      const value = qs(`[data-value="${name}"]`, el);
      if (value) value.textContent = `${settings[name]}${unit}`;
    };
    showValue('fontSize', 'px');
    showValue('lineHeight', '');
    showValue('contentWidth', 'em');
    showValue('cjkLetterSpacing', 'em');

    // Update theme circles
    qsa('.vmark-reader-theme-circle', el).forEach(btn => {
      btn.classList.toggle('active', btn.dataset.theme === settings.theme);
    });

    // Update checkboxes
    TOGGLE_SETTINGS.forEach(name => {
      const box = qs(`[data-setting="${name}"]`, el);
      if (box instanceof HTMLInputElement) box.checked = settings[name];
    });

    // Update selects
    ['latinFont', 'cjkFont'].forEach(name => {
      const select = qs(`[data-setting="${name}"]`, el);
      if (select instanceof HTMLSelectElement) select.value = name === 'latinFont' ? settings.latinFont : settings.cjkFont;
    });
  }

  // ============================================
  // Keyboard Shortcuts
  // ============================================

  /** Setup keyboard shortcuts */
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
      // Ignore if typing in input
      const target = e.target;
      if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      switch (e.key) {
        case 'Escape':
          if (isOpen) {
            togglePanel();
          }
          if (lightbox && lightbox.classList.contains('visible')) {
            closeLightbox();
          }
          break;
        case 't':
        case 'T':
          if (!e.metaKey && !e.ctrlKey) {
            settings.showToc = !settings.showToc;
            saveSettings();
            applySettings();
          }
          break;
        case '=':
        case '+':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            adjustSetting('fontSize', 1);
          }
          break;
        case '-':
          if (!e.metaKey && !e.ctrlKey) {
            e.preventDefault();
            adjustSetting('fontSize', -1);
          }
          break;
      }
    });
  }

  /** Step a range setting up (1) or down (-1). @param {string | undefined} action @param {number} dir */
  function adjustSetting(action, dir) {
    if (!isRangeSetting(action) || (dir !== 1 && dir !== -1)) return;

    settings[action] = clampSetting(action, settings[action] + dir * BOUNDS[action].step);
    saveSettings();
    applySettings();
  }

  // ============================================
  // Back to Top Button
  // ============================================

  /** @type {HTMLElement | null} */
  let backToTopBtn = null;

  /** Create back to top button */
  function createBackToTop() {
    const btn = document.createElement('button');
    backToTopBtn = btn;
    btn.className = 'vmark-back-to-top';
    btn.setAttribute('aria-label', 'Back to top');
    btn.innerHTML = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="18 15 12 9 6 15"></polyline>
    </svg>`;

    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: scrollBehavior() });
    });

    document.body.appendChild(btn);

    // Show/hide based on scroll position
    window.addEventListener('scroll', updateBackToTop, { passive: true });
    updateBackToTop();
  }

  function updateBackToTop() {
    if (!backToTopBtn) return;
    const show = window.scrollY > 300;
    backToTopBtn.classList.toggle('visible', show);
  }

  // ============================================
  // Reading Progress Indicator
  // ============================================

  /** @type {HTMLElement | null} */
  let progressBar = null;
  /** @type {HTMLElement | null} */
  let progressFill = null;

  /** Create reading progress bar */
  function createProgressBar() {
    const bar = document.createElement('div');
    bar.className = 'vmark-progress-bar';
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Reading progress');

    const fill = document.createElement('div');
    fill.className = 'vmark-progress-fill';
    bar.appendChild(fill);

    document.body.appendChild(bar);
    progressBar = bar;
    progressFill = fill;

    window.addEventListener('scroll', updateProgress, { passive: true });
    updateProgress();
  }

  function updateProgress() {
    if (!progressBar || !progressFill) return;
    const scrollTop = window.scrollY;
    const docHeight = document.documentElement.scrollHeight - window.innerHeight;
    const progress = docHeight > 0 ? (scrollTop / docHeight) * 100 : 0;
    progressFill.style.width = `${progress}%`;
    progressBar.setAttribute('aria-valuenow', String(Math.round(progress)));
  }

  // ============================================
  // Image Lightbox
  // ============================================

  /** @type {HTMLElement | null} */
  let lightbox = null;

  /** Setup image lightbox */
  function setupImageLightbox() {
    // Create lightbox container
    const box = document.createElement('div');
    box.className = 'vmark-lightbox';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Image preview');
    box.innerHTML = `
      <button class="vmark-lightbox-close" aria-label="Close">&times;</button>
      <img class="vmark-lightbox-img" src="" alt="">
    `;

    box.addEventListener('click', (e) => {
      const target = e.target;
      if (target === box || (target instanceof Element && target.classList.contains('vmark-lightbox-close'))) {
        closeLightbox();
      }
    });

    document.body.appendChild(box);
    lightbox = box;

    // Add click handlers to images
    const editor = qs('.export-surface-editor');
    if (editor) {
      editor.querySelectorAll('img').forEach(img => {
        // Skip broken images and tiny images (use naturalWidth for accurate check)
        if (img.classList.contains('broken-image') ||
            (img.complete && img.naturalWidth < 50)) return;

        img.style.cursor = 'zoom-in';
        img.setAttribute('tabindex', '0');
        img.setAttribute('role', 'button');
        img.setAttribute('aria-label', 'Click to enlarge image');

        img.addEventListener('click', () => openLightbox(img.src, img.alt));
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openLightbox(img.src, img.alt);
          }
        });
      });
    }
  }

  /** @param {string} src @param {string} alt */
  function openLightbox(src, alt) {
    if (!lightbox) return;
    const img = lightbox.querySelector('img');
    if (img) {
      img.src = src;
      img.alt = alt || '';
    }
    lightbox.classList.add('visible');
    document.body.style.overflow = 'hidden';
    const close = lightbox.querySelector('button');
    if (close) close.focus();
  }

  function closeLightbox() {
    if (!lightbox) return;
    lightbox.classList.remove('visible');
    document.body.style.overflow = '';
  }

  // ============================================
  // Footnote Navigation
  // ============================================

  /** Scroll to `target`, flash it, and move keyboard focus to `focusTarget`. @param {HTMLElement} target @param {HTMLElement | null} focusTarget */
  function jumpTo(target, focusTarget) {
    target.scrollIntoView({ behavior: scrollBehavior(), block: 'center' });
    target.classList.add('vmark-highlight');
    setTimeout(() => target.classList.remove('vmark-highlight'), 2000);
    if (focusTarget) focusTarget.focus({ preventScroll: true });
  }

  /**
   * Footnote navigation, joined by the exporter's `data-label`.
   *
   * A label is whatever the author wrote (`[^note]`, `[^2]` before `[^1]`), so
   * it is never treated as a position and never spliced into a selector. One
   * reference may appear several times; the backlink returns to the one the
   * reader came from, or to the first. A click is taken over only when there
   * is somewhere to go — otherwise the browser keeps its default.
   */
  function setupFootnoteNavigation() {
    const editor = qs('.export-surface-editor');
    if (!editor) return;

    /** @type {Map<string, HTMLElement>} */
    const definitions = new Map();
    /** @type {Map<string, HTMLElement>} label → the reference a backlink returns to */
    const returnTo = new Map();

    qsa('[data-type="footnote_definition"]', editor).forEach(def => {
      const label = def.dataset.label;
      if (label === undefined || definitions.has(label)) return;
      definitions.set(label, def);

      const backref = document.createElement('a');
      backref.className = 'footnote-backref';
      backref.textContent = '\u21a9';
      backref.href = `#fnref-${label}`;
      backref.setAttribute('aria-label', `Back to reference ${label}`);
      (qs('dd', def) || def).appendChild(backref);
    });

    qsa('[data-type="footnote_reference"]', editor).forEach(ref => {
      const label = ref.dataset.label;
      if (label === undefined || !definitions.has(label)) return;
      if (!returnTo.has(label)) returnTo.set(label, ref);
      (qs('a', ref) || ref).setAttribute('aria-label', `Go to footnote ${label}`);
    });

    editor.addEventListener('click', (e) => {
      const origin = e.target instanceof Element ? e.target : null;
      if (!origin) return;

      const ref = origin.closest('[data-type="footnote_reference"]');
      const def = origin.closest('.footnote-backref') ? origin.closest('[data-type="footnote_definition"]') : null;
      if (ref instanceof HTMLElement) {
        const target = definitions.get(ref.dataset.label || '');
        if (!target) return;
        e.preventDefault();
        returnTo.set(ref.dataset.label || '', ref);
        jumpTo(target, qs('.footnote-backref', target));
      } else if (def instanceof HTMLElement) {
        const target = returnTo.get(def.dataset.label || '');
        if (!target) return;
        e.preventDefault();
        jumpTo(target, qs('a', target));
      }
    });
  }

  /** Initialize reader */
  function init() {
    // Wait for DOM
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
      return;
    }

    loadSettings();
    createPanel();
    applySettings();

    // Additional features
    setupKeyboardShortcuts();
    createBackToTop();
    createProgressBar();
    setupImageLightbox();
    setupFootnoteNavigation();
  }

  // Start
  init();
})();
