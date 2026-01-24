// ==UserScript==
// @name         Udacity Mentor Dashboard — Daily Income Counter
// @namespace    https://mentor-dashboard.udacity.com/
// @version      1.0.0
// @description  Sum today's earned income from Reviews + Questions and show it at the bottom of the page.
// @match        https://mentor-dashboard.udacity.com/queue/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // "Today" timezone for the daily total (uses IANA tz database).
  // Greece: Europe/Athens (handles DST automatically).
  const TODAY_TIME_ZONE = 'Europe/Athens';

  const BAR_ID = 'tm-udacity-daily-income-bar';
  const IFRAME_ID = 'tm-udacity-history-iframe';
  const DETAILS_KEY = 'tmUdacityDailyIncomeDetailsOpen';
  let lastBackgroundError = '';
  let lastStatus = 'loading'; // loading | ready | error
  const DISCOVERY_KEY = 'tmUdacityDailyIncomeApiDiscovery';
  const DISCOVERY_LOG_KEY = 'tmUdacityDailyIncomeApiDiscoveryLog';
  const CACHE_KEY = 'tmUdacityDailyIncomeCache';
  let recomputeInFlight = false;
  let recomputeQueued = false;
  let lastRenderSignature = '';
  let lastApiFetchAt = 0;
  let discoveryInstalled = false;
  let lastDataSource = 'none'; // api | history | cache | none
  const DEFAULT_RIGHT_PX = 14;
  const DEFAULT_BOTTOM_PX = 14;
  const ANCHOR_GAP_PX = 14;
  const SAFE_FALLBACK_CLEARANCE_PX = 70;

  const MONTHS = Object.freeze({
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  });

  function hasDomScaffold() {
    return !!(document.head && document.body);
  }

  async function waitForDomScaffold(timeoutMs = 30000) {
    const started = Date.now();
    while (!hasDomScaffold()) {
      if (Date.now() - started > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 50));
    }
    return true;
  }

  function formatMoney(n) {
    const safe = Number.isFinite(n) ? n : 0;
    return safe.toLocaleString(undefined, { style: 'currency', currency: 'USD' });
  }

  function getTodayParts(timeZone) {
    // Returns calendar parts { y, m, d } for "today" in the desired timezone.
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(new Date());
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      y: Number(get('year')),
      m: Number(get('month')),
      d: Number(get('day')),
    };
  }

  function getPartsForDate(date, timeZone) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    const parts = dtf.formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return {
      y: Number(get('year')),
      m: Number(get('month')),
      d: Number(get('day')),
    };
  }

  function parseMoney(text) {
    if (!text) return null;
    const m = String(text).match(/\$[\s]*([\d,]+(?:\.\d{1,2})?)/);
    if (!m) return null;
    const n = Number(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }

  function parseMonthDayYear(text) {
    // Expected like: "January 23, 2026"
    if (!text) return null;
    const m = String(text).trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
    if (!m) return null;
    const monthName = m[1].toLowerCase();
    const month = MONTHS[monthName];
    if (!month) return null;
    return {
      y: Number(m[3]),
      m: month,
      d: Number(m[2]),
    };
  }

  function sameYMD(a, b) {
    return !!a && !!b && a.y === b.y && a.m === b.m && a.d === b.d;
  }

  function tryParseDate(value) {
    if (!value) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      // Heuristic: if it's likely epoch seconds (10 digits), convert to ms.
      const ms = value < 1e12 && value > 1e9 ? value * 1000 : value;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
      // ISO-ish timestamps from APIs.
      const d = new Date(value);
      if (!Number.isNaN(d.getTime())) return d;
      // Fallback for UI-style "January 23, 2026".
      const mdY = parseMonthDayYear(value);
      if (mdY) return new Date(Date.UTC(mdY.y, mdY.m - 1, mdY.d));
    }
    return null;
  }

  function findHeadingByText(text) {
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
    return headings.find((h) => (h.textContent || '').trim() === text) || null;
  }

  function findHeadingByTextIn(doc, text) {
    const headings = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'));
    return headings.find((h) => (h.textContent || '').trim() === text) || null;
  }

  function nodesBetween(startNode, endNode, nodes) {
    // Filters `nodes` to those that appear in DOM order after startNode and before endNode.
    return nodes.filter((node) => {
      if (!startNode || !node) return false;
      const afterStart = !!(startNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
      const beforeEnd = endNode
        ? !!(endNode.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_PRECEDING)
        : true;
      return afterStart && beforeEnd;
    });
  }

  function splitRowsByTerminator(cells, terminatorRe) {
    const rows = [];
    let cur = [];
    for (const el of cells) {
      const t = (el.textContent || '').trim();
      if (!t) continue;
      cur.push(t);
      if (terminatorRe.test(t)) {
        rows.push(cur);
        cur = [];
      }
    }
    return rows;
  }

  function computeSectionSumIn(doc, { startHeadingText, endHeadingText, rowTerminatorRe }) {
    const start = findHeadingByTextIn(doc, startHeadingText);
    if (!start) return { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 };
    const end = endHeadingText ? findHeadingByTextIn(doc, endHeadingText) : null;

    const today = getTodayParts(TODAY_TIME_ZONE);

    const gridCells = Array.from(doc.querySelectorAll('[role="gridcell"]'));
    const scopedCells = nodesBetween(start, end, gridCells);
    const rows = splitRowsByTerminator(scopedCells, rowTerminatorRe);

    let sum = 0;
    let rowsCounted = 0;
    for (const row of rows) {
      const earned = row.map(parseMoney).find((n) => n != null) ?? null;
      const completed = row.map(parseMonthDayYear).find((d) => d != null) ?? null;
      if (earned == null || !completed) continue;
      if (!sameYMD(completed, today)) continue;
      sum += earned;
      rowsCounted += 1;
    }

    return { sum, found: true, rowsCounted, rowsSeen: rows.length };
  }

  function isHistoryRoute() {
    return window.location.pathname.includes('/queue/history');
  }

  function loadDiscovery() {
    try {
      const raw = localStorage.getItem(DISCOVERY_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function isApiReady(discovery) {
    // Only use API mode when BOTH endpoints exist; otherwise Overview shows partial/0 totals.
    return !!(discovery?.endpoints?.reviews && discovery?.endpoints?.questions);
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  }

  function saveCache(obj) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function saveDiscovery(obj) {
    try {
      localStorage.setItem(DISCOVERY_KEY, JSON.stringify(obj));
    } catch (_) {}
  }

  function logDiscovery(line) {
    try {
      const existing = localStorage.getItem(DISCOVERY_LOG_KEY) || '';
      localStorage.setItem(DISCOVERY_LOG_KEY, `${existing}\n${new Date().toISOString()} ${line}`.trim());
    } catch (_) {}
  }

  function getStringish(obj, keys) {
    for (const k of keys) {
      if (obj && typeof obj === 'object' && k in obj) return obj[k];
    }
    return undefined;
  }

  function toMoneyNumber(v) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') return parseMoney(v) ?? (Number.isFinite(Number(v)) ? Number(v) : null);
    return null;
  }

  function classifyItemType(obj, fallback) {
    const typeVal = String(getStringish(obj, ['type', 'taskType', 'workType', 'itemType', 'kind']) || '').toLowerCase();
    if (typeVal.includes('review')) return 'review';
    if (typeVal.includes('question') || typeVal.includes('comment') || typeVal.includes('answer')) return 'question';
    return fallback;
  }

  function extractItemsFromAny(payload, fallbackType) {
    // Walk the payload and collect objects that look like history items.
    const items = [];
    const seen = new Set();

    const stack = [payload];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const v of cur) stack.push(v);
        continue;
      }

      // Try interpret current object as an item.
      const earnedRaw = getStringish(cur, ['earned', 'amount', 'payout', 'payment', 'compensation', 'fee', 'usd', 'value']);
      const dateRaw = getStringish(cur, ['completed', 'completedAt', 'completed_at', 'submittedAt', 'submitted_at', 'createdAt', 'created_at', 'finishedAt', 'finished_at', 'date']);
      const earned = toMoneyNumber(earnedRaw);
      const date = tryParseDate(dateRaw);
      if (earned != null && date) {
        items.push({
          earned,
          completedDate: date,
          type: classifyItemType(cur, fallbackType),
        });
      }

      // Continue walk.
      for (const k of Object.keys(cur)) stack.push(cur[k]);
    }
    return items;
  }

  function computeTotalsFromItems(items) {
    const today = getTodayParts(TODAY_TIME_ZONE);
    let reviews = 0;
    let questions = 0;
    let countedReviews = 0;
    let countedQuestions = 0;

    for (const it of items) {
      const parts = getPartsForDate(it.completedDate, TODAY_TIME_ZONE);
      if (!sameYMD(parts, today)) continue;
      if (it.type === 'review') {
        reviews += it.earned;
        countedReviews += 1;
      } else if (it.type === 'question') {
        questions += it.earned;
        countedQuestions += 1;
      }
    }

    return {
      reviews,
      questions,
      countedReviews,
      countedQuestions,
    };
  }

  function summarizeItems(items) {
    let reviewItems = 0;
    let questionItems = 0;
    for (const it of items) {
      if (it.type === 'review') reviewItems += 1;
      else if (it.type === 'question') questionItems += 1;
    }
    const todayTotals = computeTotalsFromItems(items);
    return {
      itemsTotal: items.length,
      reviewItems,
      questionItems,
      ...todayTotals,
      sample: items[0]
        ? {
            earned: items[0].earned,
            completedDate: items[0].completedDate?.toISOString?.() || String(items[0].completedDate),
            type: items[0].type,
          }
        : null,
    };
  }

  function installNetworkDiscoveryHooks() {
    if (discoveryInstalled || window.__tmUdacityDailyIncomeDiscoveryInstalled) return;
    discoveryInstalled = true;
    window.__tmUdacityDailyIncomeDiscoveryInstalled = true;

    const isSameOriginish = (u) =>
      typeof u === 'string' && (u.startsWith('/') || u.includes(window.location.origin));

    const interestingUrl = (u) => {
      if (!isSameOriginish(u) && !(typeof u === 'string' && u.includes('mentor-dashboard.udacity.com'))) return false;
      // On the History page, capture *all* same-origin JSON calls (history data may be GraphQL or generic endpoints).
      if (window.location.pathname.includes('/queue/history')) return true;
      // Otherwise keep it narrower.
      return typeof u === 'string' && (
        u.includes('api') ||
        u.includes('history') ||
        u.includes('review') ||
        u.includes('question') ||
        u.includes('earn') ||
        u.includes('comp') ||
        u.includes('payment')
      );
    };

    // Hook fetch
    const origFetch = window.fetch?.bind(window);
    if (origFetch) {
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const res = await origFetch(...args);
        try {
          if (interestingUrl(url)) {
            logDiscovery(`fetch ${res.status} ${url}`);
            // Save last-seen URL as a candidate endpoint.
            const d = loadDiscovery() || {};
            d.lastFetchUrl = url;
            d.lastFetchStatus = res.status;
            d.lastFetchAt = Date.now();
            d.enabled = true;
            d.endpoints = d.endpoints || {};
            d.candidates = Array.isArray(d.candidates) ? d.candidates : [];
            d.best = d.best || { reviews: 0, questions: 0 };

            // Try parse payload (without consuming original).
            const ct = (res.headers.get('content-type') || '').toLowerCase();
            if (ct.includes('application/json')) {
              try {
                const json = await res.clone().json();
                const urlLower = String(url).toLowerCase();
                const inferredType = urlLower.includes('review') ? 'review'
                  : (urlLower.includes('question') ? 'question' : undefined);
                const items = extractItemsFromAny(json, inferredType);
                const summary = summarizeItems(items);
                d.lastParsed = {
                  at: Date.now(),
                  url,
                  items: summary.itemsTotal,
                  reviewItems: summary.reviewItems,
                  questionItems: summary.questionItems,
                  countedReviews: summary.countedReviews,
                  countedQuestions: summary.countedQuestions,
                  sample: summary.sample,
                };
                d.candidates.unshift({
                  at: Date.now(),
                  url,
                  status: res.status,
                  items: summary.itemsTotal,
                  reviewItems: summary.reviewItems,
                  questionItems: summary.questionItems,
                });
                d.candidates = d.candidates.slice(0, 25);

                // Prefer endpoints that actually look like LISTS (avoid single-item responses).
                // Pick the endpoint with the highest count seen so far.
                if (summary.reviewItems >= 3 && summary.reviewItems >= (d.best.reviews || 0)) {
                  d.best.reviews = summary.reviewItems;
                  d.endpoints.reviews = url;
                }
                if (summary.questionItems >= 3 && summary.questionItems >= (d.best.questions || 0)) {
                  d.best.questions = summary.questionItems;
                  d.endpoints.questions = url;
                }
              } catch (_) {}
            }
            saveDiscovery(d);
          }
        } catch (_) {}
        return res;
      };
    }

    // Hook XHR
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      function WrappedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
          _url = url;
          return origOpen.call(this, method, url, ...rest);
        };
        xhr.addEventListener('loadend', () => {
          try {
            if (interestingUrl(_url)) {
              logDiscovery(`xhr ${xhr.status} ${_url}`);
              const d = loadDiscovery() || {};
              d.lastXhrUrl = _url;
              d.lastXhrStatus = xhr.status;
              d.lastXhrAt = Date.now();
              d.enabled = true;
              d.endpoints = d.endpoints || {};
              d.candidates = Array.isArray(d.candidates) ? d.candidates : [];
              d.best = d.best || { reviews: 0, questions: 0 };
              const ct = String(xhr.getResponseHeader('content-type') || '').toLowerCase();
              if (ct.includes('application/json')) {
                try {
                  const json = JSON.parse(xhr.responseText || 'null');
                  const urlLower = String(_url).toLowerCase();
                  const inferredType = urlLower.includes('review') ? 'review'
                    : (urlLower.includes('question') ? 'question' : undefined);
                  const items = extractItemsFromAny(json, inferredType);
                  const summary = summarizeItems(items);
                  d.lastParsed = {
                    at: Date.now(),
                    url: _url,
                    items: summary.itemsTotal,
                    reviewItems: summary.reviewItems,
                    questionItems: summary.questionItems,
                    countedReviews: summary.countedReviews,
                    countedQuestions: summary.countedQuestions,
                    sample: summary.sample,
                  };
                  d.candidates.unshift({
                    at: Date.now(),
                    url: _url,
                    status: xhr.status,
                    items: summary.itemsTotal,
                    reviewItems: summary.reviewItems,
                    questionItems: summary.questionItems,
                  });
                  d.candidates = d.candidates.slice(0, 25);

                  if (summary.reviewItems >= 3 && summary.reviewItems >= (d.best.reviews || 0)) {
                    d.best.reviews = summary.reviewItems;
                    d.endpoints.reviews = _url;
                  }
                  if (summary.questionItems >= 3 && summary.questionItems >= (d.best.questions || 0)) {
                    d.best.questions = summary.questionItems;
                    d.endpoints.questions = _url;
                  }
                } catch (_) {}
              }
              saveDiscovery(d);
            }
          } catch (_) {}
        });
        return xhr;
      }
      window.XMLHttpRequest = WrappedXHR;
    }
  }

  function ensureHistoryIframe() {
    let iframe = document.getElementById(IFRAME_ID);
    if (iframe) return iframe;
    if (!document.body) return null;

    iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.src = `${window.location.origin}/queue/history`;
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.cssText = [
      'position: fixed',
      'left: -10000px',
      'top: 0',
      'width: 1px',
      'height: 1px',
      'opacity: 0',
      'pointer-events: none',
      'border: 0',
    ].join(';');
    iframe.addEventListener('load', () => {
      // Kick a recompute as soon as iframe navigates/updates.
      scheduleRecompute(true);
      // Observe iframe DOM changes too (history data loads client-side).
      try {
        const doc = iframe.contentDocument;
        if (doc) {
          const obs = new MutationObserver(() => scheduleRecompute());
          obs.observe(doc, { childList: true, subtree: true, characterData: true });
        }
      } catch (e) {
        lastBackgroundError = `Cannot read History iframe (blocked): ${String(e?.message || e)}`;
      }
    });
    document.body.appendChild(iframe);
    return iframe;
  }

  async function waitForHistoryDoc(timeoutMs = 30000) {
    // Preferred: fetch the History HTML with cookies and parse it.
    // This avoids iframe restrictions and works even if framing is blocked.
    try {
      const resp = await fetch(`${window.location.origin}/queue/history`, {
        credentials: 'include',
        cache: 'no-store',
      });
      if (!resp.ok) {
        lastBackgroundError = `History fetch failed: HTTP ${resp.status}`;
      } else {
        const html = await resp.text();
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const hasReviewsHeading = !!findHeadingByTextIn(doc, 'Reviews History');
        const hasGridCells = (doc.querySelectorAll('[role="gridcell"]').length || 0) > 0;
        if (hasReviewsHeading && hasGridCells) return doc;
        lastBackgroundError = 'History fetch succeeded, but no rows found in the HTML (likely rendered client-side).';
      }
    } catch (e) {
      lastBackgroundError = `History fetch error: ${String(e?.message || e)}`;
    }

    // Fallback: hidden iframe (works if the site allows framing and content is same-origin readable).
    const domOk = await waitForDomScaffold(timeoutMs);
    if (!domOk) {
      lastBackgroundError = 'Timed out waiting for the page DOM to initialize.';
      return null;
    }

    const iframe = ensureHistoryIframe();
    if (!iframe) {
      lastBackgroundError = 'Could not create History iframe (page body not available).';
      return null;
    }
    const started = Date.now();
    let forcedOnce = false;

    // Wait for iframe document to exist.
    while (Date.now() - started < timeoutMs) {
      let doc = null;
      let path = '';
      try {
        doc = iframe.contentDocument;
        path = iframe.contentWindow?.location?.pathname || '';
      } catch (e) {
        lastBackgroundError = `Cannot access History iframe (blocked): ${String(e?.message || e)}`;
        return null;
      }

      if (doc && doc.readyState !== 'loading') {
        // Some SPA states might redirect; re-navigate once if needed.
        if (!forcedOnce && path && !path.includes('/queue/history')) {
          forcedOnce = true;
          try {
            iframe.src = `${window.location.origin}/queue/history`;
          } catch (_) {}
        }

        // Wait until the client-rendered grid appears.
        const hasReviewsHeading = !!findHeadingByTextIn(doc, 'Reviews History');
        const hasGridCells = (doc.querySelectorAll('[role="gridcell"]').length || 0) > 0;
        if (hasReviewsHeading && hasGridCells) return doc;
      }
      await new Promise((r) => setTimeout(r, 350));
    }
    lastBackgroundError = 'Timed out loading History data in the background.';
    return null;
  }

  function ensureBar() {
    let bar = document.getElementById(BAR_ID);
    if (bar) return bar;
    if (!hasDomScaffold()) return null;

    bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.innerHTML = `
      <div class="tm-inner">
        <div class="tm-row">
          <div class="tm-inline">
            <span class="tm-pill"><span class="tm-k">R</span> <span class="tm-reviews">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-pill"><span class="tm-k">Q</span> <span class="tm-questions">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-pill tm-total"><span class="tm-k">T</span> <span class="tm-total-value">$0.00</span></span>
            <span class="tm-sep">·</span>
            <span class="tm-status">OK</span>
          </div>
          <button type="button" class="tm-btn tm-toggle" title="Toggle details">i</button>
        </div>
        <div class="tm-details" hidden>
          <div class="tm-meta tm-meta-1"></div>
          <div class="tm-actions">
            <button type="button" class="tm-btn tm-recalc">Recalculate</button>
            <button type="button" class="tm-btn tm-discover" title="Record History API endpoint">Enable Discovery</button>
          </div>
        </div>
      </div>
    `.trim();

    const style = document.createElement('style');
    style.textContent = `
      #${BAR_ID} {
        position: fixed;
        right: ${DEFAULT_RIGHT_PX}px;
        bottom: ${DEFAULT_BOTTOM_PX}px;
        z-index: 2147483647;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        pointer-events: none;
      }
      #${BAR_ID} .tm-inner {
        pointer-events: auto;
        width: max-content;
        max-width: 360px;
        margin: 0;
        background: rgba(20, 24, 30, 0.92);
        color: #fff;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 999px;
        padding: 4px 6px;
        box-shadow: 0 10px 22px rgba(0,0,0,0.26);
        backdrop-filter: blur(8px);
      }
      #${BAR_ID} .tm-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }
      #${BAR_ID} .tm-inline {
        display: flex;
        align-items: center;
        gap: 5px;
        flex: 1;
        min-width: 0;
        font-size: 14px;
        overflow: hidden;
      }
      #${BAR_ID} .tm-pill {
        white-space: nowrap;
      }
      #${BAR_ID} .tm-total {
        font-weight: 700;
      }
      #${BAR_ID} .tm-sep { opacity: 0.6; }
      #${BAR_ID} .tm-k {
        opacity: 0.75;
        font-weight: 700;
        letter-spacing: 0.2px;
      }
      #${BAR_ID} .tm-status {
        opacity: 0.8;
        font-weight: 600;
      }
      #${BAR_ID} .tm-meta {
        font-size: 14px;
        opacity: 0.75;
        margin-top: 4px;
      }
      #${BAR_ID} .tm-actions {
        display: flex;
        justify-content: flex-end;
        margin-top: 6px;
        gap: 6px;
      }
      #${BAR_ID} .tm-btn {
        font-size: 14px;
        padding: 3px 8px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.25);
        background: rgba(255,255,255,0.10);
        color: #fff;
        cursor: pointer;
      }
      #${BAR_ID} .tm-btn:hover { background: rgba(255,255,255,0.16); }
    `.trim();

    document.head.appendChild(style);
    document.body.appendChild(bar);

    const details = bar.querySelector('.tm-details');
    const toggleBtn = bar.querySelector('.tm-toggle');
    const setDetails = (open) => {
      if (!details) return;
      details.hidden = !open;
      try { localStorage.setItem(DETAILS_KEY, open ? '1' : '0'); } catch (_) {}
    };
    const initialOpen = (() => {
      try { return localStorage.getItem(DETAILS_KEY) === '1'; } catch (_) { return false; }
    })();
    setDetails(initialOpen);

    toggleBtn?.addEventListener('click', () => setDetails(!!details?.hidden));
    bar.querySelector('.tm-recalc')?.addEventListener('click', () => recomputeAndRender({ force: true }));
    bar.querySelector('.tm-discover')?.addEventListener('click', () => {
      installNetworkDiscoveryHooks();
      const d = loadDiscovery() || {};
      d.enabled = true;
      d.endpoints = d.endpoints || {};
      saveDiscovery(d);
      lastBackgroundError = 'Discovery enabled. Open the History tab once so the script can capture the API requests, then come back here.';
      lastStatus = 'loading';
      scheduleRecompute(true);
    });

    // Position it just above Udacity's bottom-right "Auto Refresh" box (if present).
    const position = () => positionBar(bar);
    position();
    window.addEventListener('resize', position);

    return bar;
  }

  function findAutoRefreshBox() {
    // Robust approach:
    // 1) find ANY element containing "Auto Refresh"
    // 2) walk up its ancestors to find the fixed/sticky container near bottom-right.
    const needleRe = /Auto\s+Refresh/i;
    const all = Array.from(document.querySelectorAll('body *'));

    let best = null;
    let bestScore = -Infinity;

    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (!t || !needleRe.test(t)) continue;

      // Prefer a fixed/sticky ancestor near bottom-right.
      let cur = el;
      for (let i = 0; i < 10 && cur; i += 1) {
        const rect = cur.getBoundingClientRect();
        if (!rect.width || !rect.height) {
          cur = cur.parentElement;
          continue;
        }

        const style = window.getComputedStyle(cur);
        const pos = style?.position || '';
        const isFixedLike = pos === 'fixed' || pos === 'sticky';
        const nearBottom = rect.bottom > window.innerHeight - 80;
        const nearRight = rect.right > window.innerWidth - 80;

        // If we found a plausible widget container, return immediately.
        if (isFixedLike && nearBottom && nearRight && rect.width >= 220 && rect.height >= 26) {
          return cur;
        }

        // Otherwise track the best-looking candidate.
        const areaScore = (rect.width * rect.height) / 1000;
        const score =
          (isFixedLike ? 1000 : 0) +
          (nearBottom ? 250 : 0) +
          (nearRight ? 250 : 0) +
          areaScore;
        if (score > bestScore) {
          bestScore = score;
          best = cur;
        }

        cur = cur.parentElement;
      }
    }

    return best;
  }

  function positionBar(bar) {
    try {
      const anchor = findAutoRefreshBox();
      if (!anchor) {
        bar.style.right = `${DEFAULT_RIGHT_PX}px`;
        // If the widget exists but we couldn't detect it, this avoids overlap anyway.
        bar.style.bottom = `${SAFE_FALLBACK_CLEARANCE_PX}px`;
        return;
      }

      const rect = anchor.getBoundingClientRect();
      const right = Math.max(DEFAULT_RIGHT_PX, window.innerWidth - rect.right);
      const bottom = Math.max(DEFAULT_BOTTOM_PX, window.innerHeight - rect.top + ANCHOR_GAP_PX);
      bar.style.right = `${Math.round(right)}px`;
      bar.style.bottom = `${Math.round(bottom)}px`;
    } catch (_) {
      // fall back to default positioning
      bar.style.right = `${DEFAULT_RIGHT_PX}px`;
      bar.style.bottom = `${SAFE_FALLBACK_CLEARANCE_PX}px`;
    }
  }

  function render({ reviews, questions, note }) {
    const bar = ensureBar();
    if (!bar) return;
    const total = reviews.sum + questions.sum;

    const setText = (sel, txt) => {
      const el = bar.querySelector(sel);
      if (el && el.textContent !== txt) el.textContent = txt;
    };

    const reviewsText = formatMoney(reviews.sum);
    const questionsText = formatMoney(questions.sum);
    const totalText = formatMoney(total);

    const today = getTodayParts(TODAY_TIME_ZONE);
    const tz = TODAY_TIME_ZONE ? ` (${TODAY_TIME_ZONE})` : '';
    const meta = `Counting rows completed today: ${today.y}-${String(today.m).padStart(2, '0')}-${String(today.d).padStart(2, '0')}${tz}.`;
    const details = reviews.found || questions.found
      ? `Reviews: ${reviews.rowsCounted}/${reviews.rowsSeen} rows, Questions: ${questions.rowsCounted}/${questions.rowsSeen} rows.`
      : (note || lastBackgroundError || 'Open the History tab to compute today’s total.');

    const metaText = `${meta} ${details}`;

    // Avoid needless DOM writes (prevents flicker + reduces mutation loops).
    const statusText =
      lastStatus === 'loading' ? '…' :
      lastStatus === 'error' ? 'ERR' :
      'OK';

    const signature = [
      reviewsText,
      questionsText,
      totalText,
      statusText,
      metaText,
    ].join('|');
    if (signature === lastRenderSignature) return;
    lastRenderSignature = signature;

    setText('.tm-reviews', reviewsText);
    setText('.tm-questions', questionsText);
    setText('.tm-total-value', totalText);
    setText('.tm-status', statusText);
    const d = loadDiscovery();
    const endpoints = d?.endpoints
      ? `Endpoints: reviews=${d.endpoints.reviews ? 'yes' : 'no'}, questions=${d.endpoints.questions ? 'yes' : 'no'}.`
      : 'Endpoints: none.';
    const parsed = d?.lastParsed
      ? ` Last parsed: ${new Date(d.lastParsed.at).toLocaleString()} (items=${d.lastParsed.items || 0}, reviewItems=${d.lastParsed.reviewItems || 0}, questionItems=${d.lastParsed.questionItems || 0}, today: ${d.lastParsed.countedReviews || 0} reviews / ${d.lastParsed.countedQuestions || 0} questions).`
      : '';
    const src = ` Source: ${lastDataSource}.`;
    setText('.tm-meta-1', `${metaText} ${endpoints}${parsed}${src}`);

    // Keep the bar aligned above the bottom-right box as the page changes.
    positionBar(bar);
  }

  let historyDocPromise = null;
  let historyDoc = null;

  async function recomputeAndRender({ force = false } = {}) {
    if (recomputeInFlight) {
      recomputeQueued = true;
      return;
    }
    recomputeInFlight = true;
    try {
      const discovery = loadDiscovery();
      const cache = loadCache();
      const today = getTodayParts(TODAY_TIME_ZONE);
      const cacheMatchesToday = cache && cache.today && sameYMD(cache.today, today);

      // Best path (no History visit needed *after initial discovery*):
      // call the discovered API endpoints directly and compute totals.
      if (!isHistoryRoute() && isApiReady(discovery)) {
        try {
          if (!force && Date.now() - lastApiFetchAt < 15_000) return; // throttle
          lastApiFetchAt = Date.now();
          lastStatus = 'loading';
          lastDataSource = 'api';
          render({
            reviews: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
            questions: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
            note: 'Loading totals from API…',
          });

          const urls = [
            discovery.endpoints.reviews ? { type: 'review', url: discovery.endpoints.reviews } : null,
            discovery.endpoints.questions ? { type: 'question', url: discovery.endpoints.questions } : null,
          ].filter(Boolean);

          let items = [];
          for (const entry of urls) {
            const resp = await fetch(entry.url, { credentials: 'include', cache: 'no-store' });
            const ct = (resp.headers.get('content-type') || '').toLowerCase();
            if (!resp.ok) throw new Error(`API HTTP ${resp.status} for ${entry.url}`);
            if (!ct.includes('application/json')) throw new Error(`API not JSON for ${entry.url}`);
            const json = await resp.json();
            items = items.concat(extractItemsFromAny(json, entry.type));
          }

          const totals = computeTotalsFromItems(items);
          lastStatus = 'ready';
          lastBackgroundError = '';
          lastDataSource = 'api';

          const apiCounts = (totals.countedReviews || 0) + (totals.countedQuestions || 0);
          const cacheCounts = cacheMatchesToday
            ? ((cache.countedReviews || 0) + (cache.countedQuestions || 0))
            : 0;

          // If API returns 0 items today but cache has data, prefer cache and don't overwrite it.
          if (apiCounts === 0 && cacheCounts > 0) {
            lastStatus = 'ready';
            lastDataSource = 'cache';
            render({
              reviews: { sum: cache.reviews || 0, found: true, rowsCounted: cache.countedReviews || 0, rowsSeen: cache.countedReviews || 0 },
              questions: { sum: cache.questions || 0, found: true, rowsCounted: cache.countedQuestions || 0, rowsSeen: cache.countedQuestions || 0 },
              note: 'API returned 0 for today; showing cached totals.',
            });
            return;
          }

          // Only overwrite cache when API result is meaningful for today, or cache is absent.
          if (apiCounts > 0 || !cacheMatchesToday) {
            saveCache({
              at: Date.now(),
              today,
              reviews: totals.reviews,
              questions: totals.questions,
              countedReviews: totals.countedReviews,
              countedQuestions: totals.countedQuestions,
            });
          }
          render({
            reviews: { sum: totals.reviews, found: true, rowsCounted: totals.countedReviews, rowsSeen: totals.countedReviews },
            questions: { sum: totals.questions, found: true, rowsCounted: totals.countedQuestions, rowsSeen: totals.countedQuestions },
            note: '',
          });
          return;
        } catch (e) {
          lastStatus = 'error';
          lastBackgroundError = `API mode failed: ${String(e?.message || e)}`;
          // fall through to other methods
        }
      }

      // If API is not ready yet (missing an endpoint), show today's cached totals if we have them.
      if (!isHistoryRoute() && !isApiReady(discovery) && cacheMatchesToday) {
        lastStatus = 'ready';
        lastDataSource = 'cache';
        lastBackgroundError = '';
        render({
          reviews: { sum: cache.reviews || 0, found: true, rowsCounted: cache.countedReviews || 0, rowsSeen: cache.countedReviews || 0 },
          questions: { sum: cache.questions || 0, found: true, rowsCounted: cache.countedQuestions || 0, rowsSeen: cache.countedQuestions || 0 },
          note: 'API discovery incomplete; showing cached totals.',
        });
        return;
      }

      // Prefer computing directly from the History page if we're on it.
      if (isHistoryRoute()) {
        // Ensure hooks are installed before/while History loads.
        installNetworkDiscoveryHooks();
        historyDoc = document;
        historyDocPromise = null;
      } else if (!historyDoc || force) {
        if (!historyDocPromise || force) historyDocPromise = waitForHistoryDoc();
        historyDoc = await historyDocPromise;
      }

      if (!historyDoc) {
        // If we have a cache for today, show it instead of 0.
        if (cacheMatchesToday) {
          lastStatus = 'ready';
          lastDataSource = 'cache';
          lastBackgroundError = '';
          render({
            reviews: { sum: cache.reviews || 0, found: true, rowsCounted: cache.countedReviews || 0, rowsSeen: cache.countedReviews || 0 },
            questions: { sum: cache.questions || 0, found: true, rowsCounted: cache.countedQuestions || 0, rowsSeen: cache.countedQuestions || 0 },
            note: '',
          });
          return;
        }
        lastStatus = lastBackgroundError ? 'error' : 'loading';
        lastDataSource = 'none';
        render({
          reviews: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
          questions: { sum: 0, found: false, rowsCounted: 0, rowsSeen: 0 },
          note: lastBackgroundError || 'Loading History data in the background…',
        });
        return;
      }

      const reviews = computeSectionSumIn(historyDoc, {
        startHeadingText: 'Reviews History',
        endHeadingText: 'Question History',
        rowTerminatorRe: /^View review$/i,
      });
      const questions = computeSectionSumIn(historyDoc, {
        startHeadingText: 'Question History',
        endHeadingText: null,
        rowTerminatorRe: /^View question$/i,
      });

      lastStatus = (reviews.found || questions.found) ? 'ready' : 'error';
      if (lastStatus === 'error' && !lastBackgroundError) {
        lastBackgroundError = 'History data loaded, but could not locate expected rows.';
      }
      if (lastStatus === 'ready') {
        lastDataSource = 'history';
        saveCache({
          at: Date.now(),
          today,
          reviews: reviews.sum,
          questions: questions.sum,
          countedReviews: reviews.rowsCounted,
          countedQuestions: questions.rowsCounted,
        });
      }
      render({ reviews, questions, note: '' });
    } finally {
      recomputeInFlight = false;
      if (recomputeQueued) {
        recomputeQueued = false;
        scheduleRecompute(true);
      }
    }
  }

  // Auto-recompute when the History tables update.
  let pending = null;
  function scheduleRecompute(immediate = false) {
    if (pending) return;
    pending = window.setTimeout(() => {
      pending = null;
      recomputeAndRender();
    }, immediate ? 0 : 250);
  }

  // Install discovery hooks as early as possible. With @run-at document-start,
  // this captures API calls during initial app boot.
  installNetworkDiscoveryHooks();

  // UI/DOM bootstrapping: on refresh, `document-start` can run before <head>/<body> exist.
  // If we inject too early, the bar can fail to mount and "disappear".
  let uiBooted = false;
  let bodyObserverInstalled = false;
  let warmupInstalled = false;
  let domObserverInstalled = false;

  function bootUiIfReady() {
    if (uiBooted) return;
    if (!hasDomScaffold()) return;

    uiBooted = true;
    ensureBar();

    // Fire-and-forget initial compute (async safe).
    recomputeAndRender().catch(() => {});

    if (!bodyObserverInstalled) {
      bodyObserverInstalled = true;
      const obs = new MutationObserver((mutations) => {
        const bar = document.getElementById(BAR_ID);
        const iframe = document.getElementById(IFRAME_ID);
        if (bar) {
          const onlyOurUi = mutations.every((m) => {
            const t = m.target;
            return (t instanceof Node) && bar.contains(t);
          });
          if (onlyOurUi) return;
        }
        if (iframe) {
          const onlyOurFrame = mutations.every((m) => {
            const t = m.target;
            return (t instanceof Node) && iframe.contains(t);
          });
          if (onlyOurFrame) return;
        }
        scheduleRecompute();
      });
      obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    }

    // Also re-check periodically (handles day rollover + cases where iframe loads later).
    // Quick warm-up loop to catch iframe load ASAP, then settle into 60s.
    if (!warmupInstalled) {
      warmupInstalled = true;
      let warmupTicks = 0;
      const warmup = window.setInterval(() => {
        warmupTicks += 1;
        scheduleRecompute();
        if (warmupTicks >= 20) window.clearInterval(warmup); // ~10s
      }, 500);
      window.setInterval(() => scheduleRecompute(), 60_000);
    }
  }

  // Try immediately, then on DOM milestones, and also via a DOM observer.
  bootUiIfReady();
  document.addEventListener('readystatechange', bootUiIfReady);
  document.addEventListener('DOMContentLoaded', bootUiIfReady, { once: true });
  window.addEventListener('load', bootUiIfReady, { once: true });

  if (!domObserverInstalled && document.documentElement) {
    domObserverInstalled = true;
    const domObs = new MutationObserver(() => bootUiIfReady());
    domObs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();

