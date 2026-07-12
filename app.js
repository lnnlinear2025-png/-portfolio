/* ================================================================
   Tab Out 鈥?Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly 鈥?no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   CHROME TABS 鈥?Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs 鈥?populated by fetchOpenTabs()
let openTabs = [];

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Out's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map(t => ({
      id:       t.id,
      url:      t.url,
      title:    t.title,
      windowId: t.windowId,
      active:   t.active,
      // Flag Tab Out's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === 'chrome://newtab/',
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith('file://')) {
      exactUrls.add(u);
    } else {
      try { targetHostnames.push(new URL(u).hostname); }
      catch { /* skip unparseable */ }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter(tab => {
      const tabUrl = tab.url || '';
      if (tabUrl.startsWith('file://') && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch { return false; }
    })
    .map(tab => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter(t => urlSet.has(t.url)).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter(t => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter(t => {
        try { return new URL(t.url).hostname === targetHost; }
        catch { return false; }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match = matches.find(t => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true 鈫?keep one copy of each, close the rest.
 * keepOne=false 鈫?close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter(t => t.url === url);
    if (keepOne) {
      const keep = matching.find(t => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Out new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(t =>
    t.url === newtabUrl || t.url === 'chrome://newtab/'
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Out tab in the CURRENT window 鈥?that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find(t => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find(t => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter(t => t.id !== keep.id).map(t => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}


/* ----------------------------------------------------------------
   SAVED FOR LATER 鈥?chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  deferred.push({
    id:        Date.now().toString(),
    url:       tab.url,
    title:     tab.title,
    savedAt:   new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const visible = deferred.filter(t => !t.dismissed);
  return {
    active:   visible.filter(t => !t.completed),
    archived: visible.filter(t => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get('deferred');
  const tab = deferred.find(t => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API 鈥?no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(1, ctx.sampleRate * duration, ctx.sampleRate);
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low 鈥?creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported 鈥?fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    '#c8713a', // amber
    '#e8a070', // amber light
    '#5a7a62', // sage
    '#8aaa92', // sage light
    '#5a6b7a', // slate
    '#8a9baa', // slate light
    '#d4b896', // warm paper
    '#b35a5a', // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement('div');

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5鈥?1px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? '50%' : '2px'};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle   = Math.random() * Math.PI * 2;
    const speed   = 60 + Math.random() * 120;
    const vx      = Math.cos(angle) * speed;
    const vy      = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration  = 700 + Math.random() * 200; // 700鈥?00ms

    function frame(now) {
      const elapsed  = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) { el.remove(); return; }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate  = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add('closing');
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById('openTabsMissions');
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll('.mission-card:not(.closing)').length;
  if (remaining > 0) return;

  missionsEl.classList.add('empty-city');
  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">City at rest.</div>
      <div class="empty-subtitle">No open tabs.</div>
    </div>
  `;

  const countEl = document.getElementById('openTabsSectionCount');
  if (countEl) countEl.textContent = '0 domains';
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" 鈫?"2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';
  const then = new Date(dateStr);
  const now  = new Date();
  const diffMins  = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays  = Math.floor((now - then) / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting() 鈥?"Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

/**
 * getDateDisplay() 鈥?"Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year:    'numeric',
    month:   'long',
    day:     'numeric',
  });
}


/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames 鈫?friendly display names.
const FRIENDLY_DOMAINS = {
  'github.com':           'GitHub',
  'www.github.com':       'GitHub',
  'gist.github.com':      'GitHub Gist',
  'youtube.com':          'YouTube',
  'www.youtube.com':      'YouTube',
  'music.youtube.com':    'YouTube Music',
  'x.com':                'X',
  'www.x.com':            'X',
  'twitter.com':          'X',
  'www.twitter.com':      'X',
  'reddit.com':           'Reddit',
  'www.reddit.com':       'Reddit',
  'old.reddit.com':       'Reddit',
  'substack.com':         'Substack',
  'www.substack.com':     'Substack',
  'medium.com':           'Medium',
  'www.medium.com':       'Medium',
  'linkedin.com':         'LinkedIn',
  'www.linkedin.com':     'LinkedIn',
  'stackoverflow.com':    'Stack Overflow',
  'www.stackoverflow.com':'Stack Overflow',
  'news.ycombinator.com': 'Hacker News',
  'google.com':           'Google',
  'www.google.com':       'Google',
  'mail.google.com':      'Gmail',
  'docs.google.com':      'Google Docs',
  'drive.google.com':     'Google Drive',
  'calendar.google.com':  'Google Calendar',
  'meet.google.com':      'Google Meet',
  'gemini.google.com':    'Gemini',
  'chatgpt.com':          'ChatGPT',
  'www.chatgpt.com':      'ChatGPT',
  'chat.openai.com':      'ChatGPT',
  'claude.ai':            'Claude',
  'www.claude.ai':        'Claude',
  'code.claude.com':      'Claude Code',
  'notion.so':            'Notion',
  'www.notion.so':        'Notion',
  'figma.com':            'Figma',
  'www.figma.com':        'Figma',
  'slack.com':            'Slack',
  'app.slack.com':        'Slack',
  'discord.com':          'Discord',
  'www.discord.com':      'Discord',
  'wikipedia.org':        'Wikipedia',
  'en.wikipedia.org':     'Wikipedia',
  'amazon.com':           'Amazon',
  'www.amazon.com':       'Amazon',
  'netflix.com':          'Netflix',
  'www.netflix.com':      'Netflix',
  'spotify.com':          'Spotify',
  'open.spotify.com':     'Spotify',
  'vercel.com':           'Vercel',
  'www.vercel.com':       'Vercel',
  'npmjs.com':            'npm',
  'www.npmjs.com':        'npm',
  'developer.mozilla.org':'MDN',
  'arxiv.org':            'arXiv',
  'www.arxiv.org':        'arXiv',
  'huggingface.co':       'Hugging Face',
  'www.huggingface.co':   'Hugging Face',
  'producthunt.com':      'Product Hunt',
  'www.producthunt.com':  'Product Hunt',
  'xiaohongshu.com':      'RedNote',
  'www.xiaohongshu.com':  'RedNote',
  'local-files':          'Local Files',
};

function friendlyDomain(hostname) {
  if (!hostname) return '';
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith('.substack.com') && hostname !== 'substack.com') {
    return capitalize(hostname.replace('.substack.com', '')) + "'s Substack";
  }
  if (hostname.endsWith('.github.io')) {
    return capitalize(hostname.replace('.github.io', '')) + ' (GitHub Pages)';
  }

  let clean = hostname
    .replace(/^www\./, '')
    .replace(/\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/, '');

  return clean.split('.').map(part => capitalize(part)).join(' ');
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return '';
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, '');
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, ' ');
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(/\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  title = title.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '');
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ': ');
  title = title.replace(/\s*\/\s*X\s*$/, '');
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || '';

  const friendly = friendlyDomain(hostname);
  const domain   = hostname.replace(/^www\./, '');
  const seps     = [' - ', ' | ', ' — ', ' · ', ' – '];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix     = title.slice(idx + sep.length).trim();
    const suffixLow  = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, '').toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || '';
  let pathname = '', hostname = '';
  try { const u = new URL(url); pathname = u.pathname; hostname = u.hostname; }
  catch { return title || ''; }

  const titleIsUrl = !title || title === url || title.startsWith(hostname) || title.startsWith('http');

  if ((hostname === 'x.com' || hostname === 'twitter.com' || hostname === 'www.x.com') && pathname.includes('/status/')) {
    const username = pathname.split('/')[1];
    if (username) return titleIsUrl ? `Post by @${username}` : title;
  }

  if (hostname === 'github.com' || hostname === 'www.github.com') {
    const parts = pathname.split('/').filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === 'issues' && rest[1]) return `${owner}/${repo} Issue #${rest[1]}`;
      if (rest[0] === 'pull'   && rest[1]) return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === 'blob' || rest[0] === 'tree') return `${owner}/${repo} — ${rest.slice(2).join('/')}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if ((hostname === 'www.youtube.com' || hostname === 'youtube.com') && pathname === '/watch') {
    if (titleIsUrl) return 'YouTube Video';
  }

  if ((hostname === 'www.reddit.com' || hostname === 'reddit.com' || hostname === 'old.reddit.com') && pathname.includes('/comments/')) {
    const parts  = pathname.split('/').filter(Boolean);
    const subIdx = parts.indexOf('r');
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} post`;
    }
  }

  return title || url;
}


/* ================================================================
   BUILDING SVGs 鈥?Xi'an Relief Atlas style
   Stone/cream palette, traditional Chinese architecture silhouettes
   ================================================================ */

// Colour tokens shared across all building types
const B = {
  stone:  '#D0C9B4',  // wall surface
  shadow: '#B8B09A',  // wall shadow side
  roof:   '#5A7268',  // glazed tile (blue-green grey)
  roofD:  '#3E524A',  // roof dark edge
  wood:   '#8B6F47',  // timber frame
  amber:  '#C47A3A',  // decorative accent
  red:    '#8B2635',  // banner / gate highlight
  outline:'#6B5F4A',  // general stroke
  ground: '#C0B89E',  // base / steps
};

// Hash domain string 鈫?0..3 to pick building type
function domainHash(str) {
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0x7FFFFFFF;
  return h % 4;
}

// tabCount 鈫?SVG scale factor
function buildingScale(tabCount) {
  return Math.min(1.5, 0.75 + tabCount * 0.08);
}

// Pagoda 鈥?tall, multi-tiered, spire
function svgPagoda(scale = 1) {
  const w = Math.round(68 * scale), h = Math.round(110 * scale);
  return `<svg width="${w}" height="${h}" viewBox="0 0 68 110" xmlns="http://www.w3.org/2000/svg">
    <!-- base platform -->
    <rect x="10" y="98" width="48" height="8" fill="${B.ground}" stroke="${B.outline}" stroke-width="1.2"/>
    <!-- tier 3 body -->
    <rect x="18" y="74" width="32" height="26" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <line x1="26" y1="74" x2="26" y2="100" stroke="${B.outline}" stroke-width="0.8" opacity="0.5"/>
    <line x1="42" y1="74" x2="42" y2="100" stroke="${B.outline}" stroke-width="0.8" opacity="0.5"/>
    <rect x="27" y="84" width="14" height="14" fill="${B.wood}" stroke="${B.outline}" stroke-width="0.8"/>
    <!-- tier 3 roof -->
    <polygon points="10,74 34,62 58,74" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <polygon points="10,74 12,76 34,64 56,76 58,74 34,62" fill="${B.roofD}" opacity="0.3"/>
    <!-- tier 2 body -->
    <rect x="22" y="50" width="24" height="26" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <line x1="29" y1="50" x2="29" y2="76" stroke="${B.outline}" stroke-width="0.8" opacity="0.5"/>
    <line x1="39" y1="50" x2="39" y2="76" stroke="${B.outline}" stroke-width="0.8" opacity="0.5"/>
    <!-- tier 2 roof -->
    <polygon points="16,50 34,40 52,50" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <polygon points="16,50 17.5,52 34,42 50.5,52 52,50 34,40" fill="${B.roofD}" opacity="0.3"/>
    <!-- tier 1 body -->
    <rect x="26" y="30" width="16" height="22" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <!-- tier 1 roof -->
    <polygon points="22,30 34,22 46,30" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <!-- spire -->
    <line x1="34" y1="22" x2="34" y2="10" stroke="${B.outline}" stroke-width="1.8"/>
    <circle cx="34" cy="9" r="3" fill="${B.amber}" stroke="${B.outline}" stroke-width="1"/>
    <circle cx="34" cy="14" r="2" fill="${B.amber}" stroke="${B.outline}" stroke-width="0.8"/>
  </svg>`;
}

// Traditional Hall 鈥?wide, single-story, sweeping curved roof
function svgHall(scale = 1) {
  const w = Math.round(90 * scale), h = Math.round(80 * scale);
  return `<svg width="${w}" height="${h}" viewBox="0 0 90 80" xmlns="http://www.w3.org/2000/svg">
    <!-- steps -->
    <rect x="14" y="68" width="62" height="6" fill="${B.ground}" stroke="${B.outline}" stroke-width="1"/>
    <rect x="8"  y="72" width="74" height="4" fill="${B.shadow}" stroke="${B.outline}" stroke-width="1"/>
    <!-- body -->
    <rect x="14" y="44" width="62" height="26" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <!-- columns -->
    <rect x="20" y="44" width="5" height="26" fill="${B.shadow}" stroke="${B.outline}" stroke-width="0.8"/>
    <rect x="35" y="44" width="5" height="26" fill="${B.shadow}" stroke="${B.outline}" stroke-width="0.8"/>
    <rect x="50" y="44" width="5" height="26" fill="${B.shadow}" stroke="${B.outline}" stroke-width="0.8"/>
    <rect x="65" y="44" width="5" height="26" fill="${B.shadow}" stroke="${B.outline}" stroke-width="0.8"/>
    <!-- door -->
    <rect x="37" y="54" width="16" height="16" fill="${B.wood}" stroke="${B.outline}" stroke-width="0.8"/>
    <line x1="45" y1="54" x2="45" y2="70" stroke="${B.outline}" stroke-width="0.6"/>
    <!-- curved roof (eaves sweep up at corners) -->
    <path d="M4,44 Q22,28 45,32 Q68,28 86,44 Z" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <path d="M4,44 Q22,30 45,34 Q68,30 86,44" fill="none" stroke="${B.roofD}" stroke-width="0.8"/>
    <!-- ridge ornaments -->
    <circle cx="4"  cy="44" r="3.5" fill="${B.amber}" stroke="${B.outline}" stroke-width="1"/>
    <circle cx="86" cy="44" r="3.5" fill="${B.amber}" stroke="${B.outline}" stroke-width="1"/>
    <!-- ridge line -->
    <line x1="4" y1="44" x2="86" y2="44" stroke="${B.roofD}" stroke-width="1.5"/>
    <!-- banner -->
    <rect x="32" y="34" width="26" height="10" fill="${B.red}" stroke="${B.outline}" stroke-width="0.8"/>
  </svg>`;
}

// Modern Tower 鈥?office skyscraper with traditional roof cap
function svgTower(scale = 1) {
  const w = Math.round(54 * scale), h = Math.round(110 * scale);
  return `<svg width="${w}" height="${h}" viewBox="0 0 54 110" xmlns="http://www.w3.org/2000/svg">
    <!-- base -->
    <rect x="8"  y="100" width="38" height="6" fill="${B.ground}" stroke="${B.outline}" stroke-width="1"/>
    <rect x="12" y="94"  width="30" height="8" fill="${B.shadow}" stroke="${B.outline}" stroke-width="1"/>
    <!-- main tower -->
    <rect x="14" y="22" width="26" height="74" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <!-- window grid -->
    <rect x="18" y="30" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="29" y="30" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="18" y="42" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="29" y="42" width="7" height="5" fill="${B.amber}" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="18" y="54" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="29" y="54" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="18" y="66" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="29" y="66" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="18" y="78" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="29" y="78" width="7" height="5" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.5"/>
    <!-- traditional roof cap -->
    <polygon points="10,22 27,10 44,22" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <polygon points="10,22 12,24 27,12 42,24 44,22 27,10" fill="${B.roofD}" opacity="0.3"/>
    <!-- antenna -->
    <line x1="27" y1="10" x2="27" y2="2" stroke="${B.outline}" stroke-width="1.5"/>
    <circle cx="27" cy="2" r="2" fill="${B.amber}"/>
  </svg>`;
}

// Shop / Gate 鈥?low wide building, often gateway type
function svgGate(scale = 1) {
  const w = Math.round(80 * scale), h = Math.round(72 * scale);
  return `<svg width="${w}" height="${h}" viewBox="0 0 80 72" xmlns="http://www.w3.org/2000/svg">
    <!-- ground -->
    <rect x="4"  y="64" width="72" height="4" fill="${B.ground}" stroke="${B.outline}" stroke-width="1"/>
    <!-- wall body -->
    <rect x="8"  y="40" width="64" height="26" fill="${B.stone}" stroke="${B.outline}" stroke-width="1.2"/>
    <!-- gate arch -->
    <path d="M28,66 L28,50 Q40,40 52,50 L52,66 Z" fill="${B.wood}" stroke="${B.outline}" stroke-width="0.8"/>
    <path d="M30,66 L30,51 Q40,43 50,51 L50,66 Z" fill="#5A3A20" opacity="0.6"/>
    <!-- side windows -->
    <rect x="12" y="48" width="12" height="10" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.8"/>
    <line x1="18" y1="48" x2="18" y2="58" stroke="${B.outline}" stroke-width="0.5"/>
    <rect x="56" y="48" width="12" height="10" fill="#B8C4C0" stroke="${B.outline}" stroke-width="0.8"/>
    <line x1="62" y1="48" x2="62" y2="58" stroke="${B.outline}" stroke-width="0.5"/>
    <!-- main roof 鈥?double eaves -->
    <path d="M2,40 Q20,26 40,30 Q60,26 78,40 Z" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1.2"/>
    <path d="M8,40 Q20,30 40,34 Q60,30 72,40 Z" fill="${B.roofD}" opacity="0.25"/>
    <!-- ridge -->
    <line x1="2" y1="40" x2="78" y2="40" stroke="${B.roofD}" stroke-width="1.5"/>
    <circle cx="2"  cy="40" r="3" fill="${B.amber}" stroke="${B.outline}" stroke-width="1"/>
    <circle cx="78" cy="40" r="3" fill="${B.amber}" stroke="${B.outline}" stroke-width="1"/>
    <!-- banner above gate -->
    <rect x="26" y="30" width="28" height="12" fill="${B.red}" stroke="${B.outline}" stroke-width="0.8"/>
    <line x1="30" y1="30" x2="30" y2="42" stroke="${B.outline}" stroke-width="0.5" opacity="0.4"/>
    <line x1="50" y1="30" x2="50" y2="42" stroke="${B.outline}" stroke-width="0.5" opacity="0.4"/>
    <!-- small upper roof -->
    <polygon points="20,30 40,22 60,30" fill="${B.roof}" stroke="${B.roofD}" stroke-width="1"/>
    <line x1="20" y1="30" x2="60" y2="30" stroke="${B.roofD}" stroke-width="1"/>
  </svg>`;
}

const BUILDING_RENDERERS = [svgPagoda, svgHall, svgTower, svgGate];

/**
 * renderPinUnit(group, index)
 * Renders a domain group as a street-map pin (Direction B).
 * Odd indices 鈫?label above road; even 鈫?label below.
 */
function renderPinUnit(group, index) {
  const tabs      = group.tabs || [];
  const count     = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const label     = isLanding ? 'homepages' : (group.label || friendlyDomain(group.domain));
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');
  const position  = index % 2 === 0 ? 'pin-above' : 'pin-below';

  const groupData = encodeURIComponent(JSON.stringify({
    domain:   group.domain,
    label,
    stableId,
    tabs: tabs.map(t => ({ url: t.url, title: t.title || t.url })),
  }));

  const labelHtml = `
    <div class="pin-label">
      <div class="pin-dot-label"></div>
      ${escapeHtml(label.slice(0, 18))}
      ${count > 1 ? `<span class="pin-count">${count}</span>` : ''}
    </div>`;

  return `
    <div class="pin-item ${position}"
         data-domain-id="${stableId}"
         data-group="${groupData.replace(/"/g, '&quot;')}"
         onmouseenter="showTabHoverPanel(this, event)"
         onmouseleave="scheduleHoverPanelHide()">
      ${labelHtml}
      <div class="pin-stem"></div>
      <div class="pin-road-dot"></div>
    </div>`;
}

// renderBuildingUnit kept as alias for backward compat
const renderBuildingUnit = renderPinUnit;

/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs:    `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus:   `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};


/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];


/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages 鈥?no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  return openTabs.filter(t => {
    const url = t.url || '';
    return (
      !url.startsWith('chrome://') &&
      !url.startsWith('chrome-extension://') &&
      !url.startsWith('about:') &&
      !url.startsWith('edge://') &&
      !url.startsWith('brave://')
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Out pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter(t => t.isTabOut);
  const banner  = document.getElementById('tabOutDupeBanner');
  const countEl = document.getElementById('tabOutDupeCount');
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = 'flex';
  } else {
    banner.style.display = 'none';
  }
}


/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs.map(tab => {
    const label    = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), '');
    const count    = urlCounts[tab.url] || 1;
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconImg(domain, 13, 'chip-favicon')}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">+${hiddenTabs.length} more</span>
    </div>`;
}


/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs      = group.tabs || [];
  const tabCount  = tabs.length;
  const isLanding = group.domain === '__landing-pages__';
  const stableId  = 'domain-' + group.domain.replace(/[^a-z0-9]/g, '-');

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls   = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes   = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} tab${tabCount !== 1 ? 's' : ''} open
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </span>`
    : '';

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) { seen.add(tab.url); uniqueTabs.push(tab); }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount  = uniqueTabs.length - visibleTabs.length;

  const pageChips = visibleTabs.map(tab => {
    let label = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), group.domain);
    // For localhost tabs, prepend port number so you can tell projects apart
    try {
      const parsed = new URL(tab.url);
      if (parsed.hostname === 'localhost' && parsed.port) label = `${parsed.port} ${label}`;
    } catch {}
    const count    = urlCounts[tab.url];
    const dupeTag  = count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : '';
    const chipClass = count > 1 ? ' chip-has-dupes' : '';
    const safeUrl   = (tab.url || '').replace(/"/g, '&quot;');
    const safeTitle = label.replace(/"/g, '&quot;');
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    return `<div class="page-chip clickable${chipClass}" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      ${faviconImg(domain, 13, 'chip-favicon')}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="Save for later">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close this tab">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
  }).join('') + (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : '');

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      Close all ${tabCount} tab${tabCount !== 1 ? 's' : ''}
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls.map(([url]) => encodeURIComponent(url)).join(',');
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        Close ${totalExtras} duplicate${totalExtras !== 1 ? 's' : ''}
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? 'has-amber-bar' : 'has-neutral-bar'}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? 'Homepages' : (group.label || friendlyDomain(group.domain))}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">tabs</div>
      </div>
    </div>`;
}


/* ----------------------------------------------------------------
   SAVED FOR LATER 鈥?Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column         = document.getElementById('deferredSection');
  const list           = document.getElementById('deferredList');
  const empty          = document.getElementById('deferredEmpty');
  const countEl        = document.getElementById('deferredCount');
  const archiveEl      = document.getElementById('deferredArchive');
  const archiveCountEl = document.getElementById('archiveCount');
  const archiveList    = document.getElementById('archiveList');

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = 'none';
      return;
    }

    column.style.display = 'block';

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} item${active.length !== 1 ? 's' : ''}`;
      list.innerHTML = active.map(item => renderDeferredItem(item)).join('');
      list.style.display = 'block';
      empty.style.display = 'none';
    } else {
      list.style.display = 'none';
      countEl.textContent = '';
      empty.style.display = 'block';
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      archiveEl.style.display = 'block';
    } else {
      archiveEl.style.display = 'none';
    }

  } catch (err) {
    console.warn('[tab-out] Could not load saved tabs:', err);
    column.style.display = 'none';
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = '';
  try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
  const ago = timeAgo(item.savedAt);

  const safeUrl   = item.url.replace(/"/g, '&quot;');
  const safeTitle = (item.title || item.url).replace(/"/g, '&quot;');
  return `
    <div class="deferred-item" data-deferred-id="${item.id}"
         draggable="true" data-url="${safeUrl}" data-title="${safeTitle}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
          <span style="display:inline-flex;vertical-align:-2px;margin-right:4px">${faviconImg(domain, 14)}</span>${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="Dismiss">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt ? timeAgo(item.completedAt) : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || '').replace(/"/g, '&quot;')}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    { hostname: 'mail.google.com', test: (p, h) =>
        !h.includes('#inbox/') && !h.includes('#sent/') && !h.includes('#search/') },
    { hostname: 'x.com',               pathExact: ['/home'] },
    { hostname: 'www.linkedin.com',    pathExact: ['/'] },
    { hostname: 'github.com',          pathExact: ['/'] },
    { hostname: 'www.youtube.com',     pathExact: ['/'] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== 'undefined' ? LOCAL_LANDING_PAGE_PATTERNS : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some(p => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test)       return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact)  return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === '/';
      });
    } catch { return false; }
  }

  domainGroups = [];
  const groupMap    = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups = typeof LOCAL_CUSTOM_GROUPS !== 'undefined' ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return customGroups.find(r => {
        const hostMatch = r.hostname
          ? parsed.hostname === r.hostname
          : r.hostnameEndsWith
            ? parsed.hostname.endsWith(r.hostnameEndsWith)
            : false;
        if (!hostMatch) return false;
        if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
        return true; // hostname matched, no path filter
      }) || null;
    } catch { return null; }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key]) groupMap[key] = { domain: key, label: customRule.groupLabel, tabs: [] };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith('file://')) {
        hostname = 'local-files';
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname]) groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap['__landing-pages__'] = { domain: '__landing-pages__', tabs: landingTabs };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(LANDING_PAGE_PATTERNS.map(p => p.hostname).filter(Boolean));
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(p => p.hostnameEndsWith).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some(s => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === '__landing-pages__';
    const bIsLanding = b.domain === '__landing-pages__';
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection      = document.getElementById('openTabsSection');
  const openTabsMissionsEl   = document.getElementById('openTabsMissions');
  const openTabsSectionCount = document.getElementById('openTabsSectionCount');

  if (domainGroups.length > 0 && openTabsSection) {
    openTabsSectionCount.textContent = `${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''} · ${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''}`;
    openTabsMissionsEl.innerHTML = domainGroups.map(g => renderDomainCard(g)).join('');
    openTabsSection.style.display = 'block';
  } else if (openTabsSection) {
    openTabsSection.style.display = 'none';
  }

  // --- Stats ---
  const sidebarTabCount = document.getElementById('sidebarTabCount');
  if (sidebarTabCount) sidebarTabCount.textContent = realTabs.length;
  const tabsStats = document.getElementById('tabsStats');
  if (tabsStats) tabsStats.textContent = `${realTabs.length} tab${realTabs.length !== 1 ? 's' : ''} across ${domainGroups.length} domain${domainGroups.length !== 1 ? 's' : ''}`;

  // --- Check for duplicate Tab Out tabs ---
  checkTabOutDupes();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}


/* ----------------------------------------------------------------
   EVENT HANDLERS 鈥?using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Out tabs ----
  if (action === 'close-tabout-dupes') {
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById('tabOutDupeBanner');
    if (banner) {
      banner.style.transition = 'opacity 0.4s';
      banner.style.opacity = '0';
      setTimeout(() => { banner.style.display = 'none'; banner.style.opacity = '1'; }, 400);
    }
    showToast('Closed extra Folio tabs');
    return;
  }

  const card = actionEl.closest('.mission-card');

  // ---- Expand overflow chips ("+N more") ----
  if (action === 'expand-chips') {
    const overflowContainer = actionEl.parentElement.querySelector('.page-chips-overflow');
    if (overflowContainer) {
      overflowContainer.style.display = 'contents';
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === 'focus-tab') {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === 'close-single-tab') {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    // Close the tab in Chrome directly
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector('.mission-card:has(.mission-pages:empty)');
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll('.mission-card').forEach(c => {
          if (c.querySelectorAll('.page-chip[data-action="focus-tab"]').length === 0) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const sidebarTabCountEl = document.getElementById('sidebarTabCount');
    if (sidebarTabCountEl) sidebarTabCountEl.textContent = openTabs.length;

    showToast('Tab closed');
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === 'defer-single-tab') {
    e.stopPropagation();
    const tabUrl   = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error('[tab-out] Failed to save tab:', err);
      showToast('Failed to save tab');
      return;
    }

    // Close the tab in Chrome
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tabUrl);
    if (match) await chrome.tabs.remove(match.id);
    await fetchOpenTabs();

    // Animate chip out
    const chip = actionEl.closest('.page-chip');
    if (chip) {
      chip.style.transition = 'opacity 0.2s, transform 0.2s';
      chip.style.opacity    = '0';
      chip.style.transform  = 'scale(0.8)';
      setTimeout(() => chip.remove(), 200);
    }

    showToast('Saved for later');
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === 'check-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('checked');
      setTimeout(() => {
        item.classList.add('removing');
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === 'dismiss-deferred') {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await dismissSavedTab(id);

    const item = actionEl.closest('.deferred-item');
    if (item) {
      item.classList.add('removing');
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === 'close-domain-tabs') {
    const domainId = actionEl.dataset.domainId;
    const group    = domainGroups.find(g => {
      return 'domain-' + g.domain.replace(/[^a-z0-9]/g, '-') === domainId;
    });
    if (!group) return;

    const urls      = group.tabs.map(t => t.url);
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact  = group.domain === '__landing-pages__' || !!group.label;

    if (useExact) {
      await closeTabsExact(urls);
    } else {
      await closeTabsByUrls(urls);
    }

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    const groupLabel = group.domain === '__landing-pages__' ? 'Homepages' : (group.label || friendlyDomain(group.domain));
    showToast(`Closed ${urls.length} tab${urls.length !== 1 ? 's' : ''} from ${groupLabel}`);

    const sidebarTabCountEl = document.getElementById('sidebarTabCount');
    if (sidebarTabCountEl) sidebarTabCountEl.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === 'dedup-keep-one') {
    const urlsEncoded = actionEl.dataset.dupeUrls || '';
    const urls = urlsEncoded.split(',').map(u => decodeURIComponent(u)).filter(Boolean);
    if (urls.length === 0) return;

    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = 'opacity 0.2s';
    actionEl.style.opacity    = '0';
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll('.chip-dupe-badge').forEach(b => {
        b.style.transition = 'opacity 0.2s';
        b.style.opacity    = '0';
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll('.open-tabs-badge').forEach(badge => {
        if (badge.textContent.includes('duplicate')) {
          badge.style.transition = 'opacity 0.2s';
          badge.style.opacity    = '0';
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove('has-amber-bar');
      card.classList.add('has-neutral-bar');
    }

    showToast('Closed duplicates, kept one copy each');
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === 'close-all-open-tabs') {
    const allUrls = openTabs
      .filter(t => t.url && !t.url.startsWith('chrome') && !t.url.startsWith('about:'))
      .map(t => t.url);
    await closeTabsByUrls(allUrls);
    playCloseSound();

    document.querySelectorAll('#openTabsMissions .mission-card').forEach(c => {
      shootConfetti(
        c.getBoundingClientRect().left + c.offsetWidth / 2,
        c.getBoundingClientRect().top  + c.offsetHeight / 2
      );
      animateCardOut(c);
    });

    showToast('All tabs closed. Fresh start.');
    return;
  }
});

// ---- Archive toggle 鈥?expand/collapse the archive section ----
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('#archiveToggle');
  if (!toggle) return;

  toggle.classList.toggle('open');
  const body = document.getElementById('archiveBody');
  if (body) {
    body.style.display = body.style.display === 'none' ? 'block' : 'none';
  }
});

// ---- Archive search 鈥?filter archived items as user types ----
document.addEventListener('input', async (e) => {
  if (e.target.id !== 'archiveSearch') return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById('archiveList');
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived.map(item => renderArchiveItem(item)).join('');
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(item =>
      (item.title || '').toLowerCase().includes(q) ||
      (item.url  || '').toLowerCase().includes(q)
    );

    archiveList.innerHTML = results.map(item => renderArchiveItem(item)).join('')
      || '<div style="font-size:12px;color:var(--muted);padding:8px 0">No results</div>';
  } catch (err) {
    console.warn('[tab-out] Archive search failed:', err);
  }
});


/* ================================================================
   VIEW SWITCHING
   ================================================================ */

function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const view = document.getElementById('view-' + viewName);
  if (view) view.classList.add('active');

  const navBtn = document.querySelector(`.nav-item[data-view="${viewName}"]`);
  if (navBtn) navBtn.classList.add('active');
}

document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});


/* ================================================================
   RECENT HISTORY
   ================================================================ */

let currentTimeFilter = 'today';

/* filterBrowserPages 鈥?strip chrome://, extension pages, etc. */
function filterBrowserPages(items) {
  return items.filter(i =>
    i.url &&
    !i.url.startsWith('chrome://') &&
    !i.url.startsWith('chrome-extension://') &&
    !i.url.startsWith('about:') &&
    !i.url.startsWith('edge://')
  );
}

/* groupByDomain 鈥?merge history items by hostname, count pages per domain,
   pick the most-recently-visited URL as the representative link. */
function groupByDomain(items) {
  const map = new Map(); // hostname 鈫?{ domain, repUrl, repTitle, count, lastVisit }
  for (const item of items) {
    let hostname = '';
    try { hostname = new URL(item.url).hostname || '_unknown'; } catch { hostname = '_unknown'; }
    if (!map.has(hostname)) {
      map.set(hostname, {
        domain:    hostname,
        repUrl:    item.url,
        repTitle:  item.title || item.url,
        count:     0,
        lastVisit: item.lastVisitTime || 0,
      });
    }
    const entry = map.get(hostname);
    entry.count++;
    if ((item.lastVisitTime || 0) > entry.lastVisit) {
      entry.lastVisit  = item.lastVisitTime || 0;
      entry.repUrl     = item.url;
      entry.repTitle   = item.title || item.url;
    }
  }
  // Sort by count desc, then lastVisit desc
  return [...map.values()].sort((a, b) =>
    b.count !== a.count ? b.count - a.count : b.lastVisit - a.lastVisit
  );
}

async function renderRecentHistory(filter) {
  if (filter) currentTimeFilter = filter;
  const list = document.getElementById('recentList');
  if (!list) return;

  const startTimes = {
    today: Date.now() - 24 * 60 * 60 * 1000,
    week:  Date.now() - 7 * 24 * 60 * 60 * 1000,
    all:   0,
  };

  try {
    const raw = await chrome.history.search({
      text: '',
      maxResults: 500,
      startTime: startTimes[currentTimeFilter] ?? startTimes.week,
    });

    const real = filterBrowserPages(raw);

    if (real.length === 0) {
      list.innerHTML = '<div style="font-family:\'Space Mono\',monospace;font-size:11px;color:#9A9490;padding:12px 0;font-style:italic">No history yet.</div>';
      return;
    }

    if (currentTimeFilter === 'today') {
      // TODAY 鈥?individual URLs sorted by last visit time (most recent first)
      const sorted = [...real].sort((a, b) => (b.lastVisitTime || 0) - (a.lastVisitTime || 0));
      const PAGE = 20;

      function renderTodayItems(items) {
        return items.map(item => {
          let domain = '';
          try { domain = new URL(item.url).hostname; } catch {}
          const title    = item.title || item.url;
          const shortUrl = item.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
          const safeUrl   = item.url.replace(/"/g, '&quot;');
          const safeTitle = title.replace(/"/g, '&quot;');
          return `
            <div class="recent-item-wrap" draggable="true"
                 data-url="${safeUrl}" data-title="${safeTitle}">
              <a class="recent-item" href="${item.url}" target="_top">
                ${faviconImg(domain, 14, 'recent-favicon')}
                <div class="recent-info">
                  <div class="recent-title">${escapeHtml(title.slice(0, 60))}</div>
                  <div class="recent-url">${escapeHtml(shortUrl.slice(0, 50))}</div>
                </div>
              </a>
              <button class="recent-menu-btn" data-action="open-recent-menu"
                      data-url="${safeUrl}" data-title="${safeTitle}" title="Pin to city map">···</button>
            </div>`;
        }).join('');
      }

      let shown = PAGE;
      function paint() {
        const visible  = sorted.slice(0, shown);
        const remaining = sorted.length - shown;
        const showMoreBtn = remaining > 0
          ? `<button class="recent-show-more" id="recentShowMore">
               show ${Math.min(remaining, PAGE)} more
               <span style="opacity:0.5;margin-left:6px">(${remaining} left)</span>
             </button>`
          : '';
        list.innerHTML = renderTodayItems(visible) + showMoreBtn;
        document.getElementById('recentShowMore')?.addEventListener('click', () => {
          shown += PAGE;
          paint();
        });
      }
      paint();

    } else {
      // THIS WEEK / ALL TIME 鈥?group by domain, merge, show ×N count
      const groups = groupByDomain(real);
      list.innerHTML = groups.map(g => {
        const safeUrl   = g.repUrl.replace(/"/g, '&quot;');
        const safeTitle = g.repTitle.replace(/"/g, '&quot;');
        const countBadge = g.count > 1
          ? `<span class="recent-count-badge">×${g.count}</span>`
          : '';
        return `
          <div class="recent-item-wrap" draggable="true"
               data-url="${safeUrl}" data-title="${safeTitle}">
            <a class="recent-item" href="${g.repUrl}" target="_top">
              ${faviconImg(g.domain, 14, 'recent-favicon')}
              <div class="recent-info">
                <div class="recent-title">${escapeHtml((friendlyDomain(g.domain) || g.domain).slice(0, 40))}</div>
                <div class="recent-url">${escapeHtml(g.domain)}</div>
              </div>
              ${countBadge}
            </a>
            <button class="recent-menu-btn" data-action="open-recent-menu"
                    data-url="${safeUrl}" data-title="${safeTitle}" title="Pin to city map">···</button>
          </div>`;
      }).join('');
    }

  } catch {
    list.innerHTML = '<div style="font-family:\'Space Mono\',monospace;font-size:11px;color:#9A9490;padding:12px 0">History unavailable.</div>';
  }
}

/* renderFrequentSites 鈥?sidebar "frequent" panel.
   Uses last 30 days, groups by domain, shows top 10 by visit count. */
async function renderFrequentSites() {
  const sidebarEl = document.getElementById('sidebarRecents');
  if (!sidebarEl) return;

  try {
    const raw = await chrome.history.search({
      text: '',
      maxResults: 500,
      startTime: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });

    const real   = filterBrowserPages(raw);
    const groups = groupByDomain(real).slice(0, 10);

    if (groups.length === 0) {
      sidebarEl.innerHTML = '<div style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--ink-muted);padding:10px 20px;font-style:italic">No history yet.</div>';
      return;
    }

    sidebarEl.innerHTML = groups.map(g => {
      const name = friendlyDomain(g.domain) || g.domain;
      return `
        <a class="sidebar-recent-item" href="${g.repUrl}" target="_top" title="${escapeHtml(name)}">
          ${faviconImg(g.domain, 12, 'sidebar-recent-favicon')}
          <span class="sidebar-recent-title">${escapeHtml(name.slice(0, 22))}</span>
          ${g.count > 1 ? `<span class="sidebar-freq-count">×${g.count}</span>` : ''}
        </a>`;
    }).join('');
  } catch {
    sidebarEl.innerHTML = '';
  }
}


/* ================================================================
   SEARCH BAR
   ================================================================ */

document.getElementById('searchInput')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const query = e.target.value.trim();
  if (!query) return;

  let url;
  if (/^https?:\/\//i.test(query)) {
    url = query;
  } else if (/^[\w-]+\.[a-z]{2,}(\/|$)/i.test(query) && !query.includes(' ')) {
    url = 'https://' + query;
  } else {
    url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
  }

  chrome.tabs.update({ url });
});


/* ================================================================
   BACKGROUND MANAGEMENT
   ================================================================ */

const BG_PRESETS = [
  { name: 'Night',    value: 'linear-gradient(135deg, #0f0c29 0%, #302b63 50%, #24243e 100%)' },
  { name: 'Ocean',    value: 'linear-gradient(135deg, #0f2027 0%, #203a43 50%, #2c5364 100%)' },
  { name: 'Forest',   value: 'linear-gradient(135deg, #134e5e 0%, #71b280 100%)' },
  { name: 'Dusk',     value: 'linear-gradient(135deg, #642B73 0%, #C6426E 100%)' },
  { name: 'Aurora',   value: 'linear-gradient(135deg, #0f0c29 0%, #1a0533 40%, #0d3320 100%)' },
  { name: 'Midnight', value: 'linear-gradient(135deg, #000000 0%, #1a1a2e 50%, #16213e 100%)' },
];

async function initBackground() {
  const { bgValue } = await chrome.storage.local.get('bgValue');
  applyBackground(bgValue || BG_PRESETS[0].value);
  renderBgPicker(bgValue || BG_PRESETS[0].value);
}

function applyBackground(value) {
  const layer = document.getElementById('bg-layer');
  if (!layer) return;
  if (value.startsWith('http') || value.startsWith('data:')) {
    layer.style.backgroundImage = `url("${value}")`;
    layer.style.background = '';
  } else {
    layer.style.backgroundImage = '';
    layer.style.background = value;
  }
}

function renderBgPicker(current) {
  const container = document.getElementById('bgPresets');
  if (!container) return;
  container.innerHTML = BG_PRESETS.map(p => `
    <div class="bg-preset ${p.value === current ? 'selected' : ''}"
         style="background: ${p.value}"
         data-bg-value="${p.value.replace(/"/g, '&quot;')}">
      <div class="bg-preset-label">${p.name}</div>
    </div>
  `).join('');
}

document.getElementById('openBgPicker')?.addEventListener('click', () => {
  document.getElementById('bgPicker').style.display = 'flex';
});

document.getElementById('bgPickerClose')?.addEventListener('click', () => {
  document.getElementById('bgPicker').style.display = 'none';
});

document.getElementById('bgPicker')?.addEventListener('click', async (e) => {
  const preset = e.target.closest('[data-bg-value]');
  if (preset) {
    const value = preset.dataset.bgValue;
    applyBackground(value);
    await chrome.storage.local.set({ bgValue: value });
    renderBgPicker(value);
    return;
  }
  if (e.target === document.getElementById('bgPicker')) {
    document.getElementById('bgPicker').style.display = 'none';
  }
});

document.getElementById('bgApplyBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('bgUrlInput');
  const value = input.value.trim();
  if (!value) return;
  applyBackground(value);
  await chrome.storage.local.set({ bgValue: value });
  renderBgPicker(value);
  input.value = '';
  document.getElementById('bgPicker').style.display = 'none';
});


/* ================================================================
   TODO LIST
   ================================================================ */

async function getTodos() {
  const { todos = [] } = await chrome.storage.local.get('todos');
  return todos;
}

async function saveTodos(todos) {
  await chrome.storage.local.set({ todos });
}

async function addTodo(text, url, pinId) {
  const todos = await getTodos();
  const item = { id: Date.now().toString(), text, done: false, createdAt: new Date().toISOString() };
  if (url)   item.url   = url;
  if (pinId) item.pinId = pinId;
  todos.push(item);
  await saveTodos(todos);
}

async function toggleTodo(id) {
  const todos = await getTodos();
  const t = todos.find(t => t.id === id);
  if (t) {
    t.done = !t.done;
    if (t.done && t.pinId) await markPinRead(t.pinId);
  }
  await saveTodos(todos);
}

async function deleteTodo(id) {
  const todos = await getTodos();
  await saveTodos(todos.filter(t => t.id !== id));
}

async function clearDoneTodos() {
  const todos = await getTodos();
  await saveTodos(todos.filter(t => !t.done));
}

function formatTodoDateHeader(dateStr) {
  const d    = new Date(dateStr);
  const now  = new Date();
  const diff = Math.floor((now.setHours(0,0,0,0) - d.setHours(0,0,0,0)) / 86400000);
  if (diff === 0) return { label: 'Today',     sub: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  if (diff === 1) return { label: 'Yesterday', sub: new Date(Date.now()-86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) };
  return {
    label: d.toLocaleDateString('en-US', { weekday: 'long' }),
    sub:   d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

function todoItemHtml(t) {
  return `
    <div class="todo-item ${t.done ? 'done' : ''}" data-todo-id="${t.id}">
      <input type="checkbox" class="todo-check" ${t.done ? 'checked' : ''}
             data-action="toggle-todo" data-todo-id="${t.id}">
      ${t.url
        ? `<a class="todo-text todo-link" href="${t.url.replace(/"/g,'&quot;')}" target="_top">${escapeHtml(t.text)}</a>`
        : `<span class="todo-text" title="Double-click to edit">${escapeHtml(t.text)}</span>`
      }
      <button class="todo-delete" data-action="delete-todo" data-todo-id="${t.id}" title="Delete">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
      </button>
    </div>`;
}

/* Double-click to edit todo text */
document.addEventListener('dblclick', async (e) => {
  const span = e.target.closest('.todo-text');
  if (!span) return;
  if (span.tagName === 'A') return; // linked todos navigate on click, not edit
  const item = span.closest('.todo-item');
  if (!item) return;
  const id = item.dataset.todoId;

  // Replace span with inline input
  const current = span.textContent;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = current;
  input.className = 'todo-edit-input';
  span.replaceWith(input);
  input.focus();
  input.select();

  async function commit() {
    const newText = input.value.trim();
    if (newText && newText !== current) {
      const todos = await getTodos();
      const t = todos.find(t => t.id === id);
      if (t) { t.text = newText; await saveTodos(todos); }
    }
    await renderTodoPanel();
    // Also refresh schedule sidebar if visible
    if (document.getElementById('todoTabSchedule')?.style.display !== 'none') {
      renderScheduleGrid();
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { renderTodoPanel(); }
  });
  input.addEventListener('blur', commit);
});

async function renderTodoPanel() {
  const todos   = await getTodos();
  const list    = document.getElementById('todoList');
  const empty   = document.getElementById('todoEmpty');
  const footer  = document.getElementById('todoFooter');
  const pending = document.getElementById('todoPending');
  if (!list) return;

  const pending_count = todos.filter(t => !t.done).length;

  if (todos.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    footer.style.display = 'none';
    return;
  }

  empty.style.display = 'none';
  footer.style.display = 'flex';
  if (pending) pending.textContent = pending_count > 0 ? `${pending_count} remaining` : 'all done!';

  // Group by calendar day (newest first)
  const groups = new Map();
  for (const t of todos) {
    const day = t.createdAt
      ? new Date(t.createdAt).toDateString()
      : new Date().toDateString();
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(t);
  }

  const sortedDays = [...groups.keys()].sort((a, b) => new Date(b) - new Date(a));

  list.innerHTML = sortedDays.map(day => {
    const items  = groups.get(day);
    const { label, sub } = formatTodoDateHeader(day);
    const doneCount    = items.filter(t => t.done).length;
    const pendingCount = items.length - doneCount;
    const countLabel   = pendingCount > 0
      ? `${pendingCount} left`
      : `${doneCount} done`;

    return `
      <div class="todo-date-group">
        <div class="todo-date-header">
          <span class="todo-date-label">${label}</span>
          <span class="todo-date-sub">${sub}</span>
          <div class="todo-date-rule"></div>
          <span class="todo-date-count">${countLabel}</span>
        </div>
        <div class="todo-list">
          ${items.map(todoItemHtml).join('')}
        </div>
      </div>`;
  }).join('');
}

// Todo input handler
document.getElementById('todoInput')?.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target;
  const text = input.value.trim();
  if (!text) return;
  await addTodo(text);
  input.value = '';
  await renderTodoPanel();
});

document.getElementById('todoAddBtn')?.addEventListener('click', async () => {
  const input = document.getElementById('todoInput');
  const text = input.value.trim();
  if (!text) return;
  await addTodo(text);
  input.value = '';
  await renderTodoPanel();
});

document.getElementById('todoClearDone')?.addEventListener('click', async () => {
  await clearDoneTodos();
  await renderTodoPanel();
});

// Todo item actions (delegate)
document.addEventListener('click', async (e) => {
  const action = e.target.closest('[data-action]')?.dataset.action;
  if (action === 'toggle-todo') {
    const id = e.target.closest('[data-todo-id]').dataset.todoId;
    await toggleTodo(id);
    await renderTodoPanel();
  } else if (action === 'delete-todo') {
    const id = e.target.closest('[data-todo-id]').dataset.todoId;
    await deleteTodo(id);
    await renderTodoPanel();
  }
});


/* ================================================================
   BOOKMARKS / FOLDERS
   ================================================================ */

async function getFolders() {
  const { folders = [] } = await chrome.storage.local.get('folders');
  return folders;
}

async function saveFolders(folders) {
  await chrome.storage.local.set({ folders });
}

async function addFolder(name, icon = '📁') {
  const folders = await getFolders();
  folders.push({ id: Date.now().toString(), name, icon, links: [] });
  await saveFolders(folders);
}

async function deleteFolder(id) {
  const folders = await getFolders();
  await saveFolders(folders.filter(f => f.id !== id));
}

async function addLink(folderId, url, title) {
  const folders = await getFolders();
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return;
  folder.links.push({ id: Date.now().toString(), url, title: title || url });
  await saveFolders(folders);
}

async function deleteLink(folderId, linkId) {
  const folders = await getFolders();
  const folder = folders.find(f => f.id === folderId);
  if (!folder) return;
  folder.links = folder.links.filter(l => l.id !== linkId);
  await saveFolders(folders);
}

async function renameLink(folderId, linkId, newTitle) {
  const folders = await getFolders();
  const folder  = folders.find(f => f.id === folderId);
  if (!folder) return;
  const link = folder.links.find(l => l.id === linkId);
  if (link) link.title = newTitle;
  await saveFolders(folders);
}

async function renderBookmarksPanel() {
  const folders = await getFolders();
  const list  = document.getElementById('folderList');
  const empty = document.getElementById('bookmarksEmpty');
  if (!list) return;

  if (folders.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }

  empty.style.display = 'none';

  // City map: each folder = neighborhood, each link = building
  list.innerHTML = folders.map(f => {
    const buildingsHtml = f.links.map(l => {
      let domain = '';
      try { domain = new URL(l.url).hostname; } catch {}
      const label = escapeHtml((l.title || domain || l.url).slice(0, 14));
      return `
        <a href="${l.url}" target="_blank" rel="noopener" class="building">
          <div class="building-icon">
            ${faviconImg(domain, 20, 'building-favicon')}
            <button class="building-delete" data-action="delete-link"
                    data-folder-id="${f.id}" data-link-id="${l.id}" title="Remove">×</button>
            <button class="building-rename" data-action="rename-link"
                    data-folder-id="${f.id}" data-link-id="${l.id}" title="Rename">✎</button>
          </div>
          <div class="building-connector"></div>
          <div class="building-label">${label}</div>
        </a>`;
    }).join('');

    return `
      <div class="neighborhood" data-folder-id="${f.id}">
        <div class="neighborhood-header">
          <div class="neighborhood-name">${escapeHtml(f.name)}</div>
          <div class="neighborhood-rule"></div>
          <div class="neighborhood-actions">
            <button class="nbr-delete-btn" data-action="delete-folder"
                    data-folder-id="${f.id}">× delete</button>
          </div>
        </div>
        <div class="buildings-row">
          ${buildingsHtml || '<span style="font-family:\'Space Mono\',monospace;font-size:10px;color:#9A9490;font-style:italic">empty neighborhood</span>'}
        </div>
        <div class="add-building-row">
          <input type="text" class="add-building-input"
                 placeholder="paste url..." data-folder-id="${f.id}">
          <button class="add-building-btn" data-action="add-link"
                  data-folder-id="${f.id}">add</button>
        </div>
      </div>`;
  }).join('');
}

// Add neighborhood (folder) button
document.getElementById('addFolderBtn')?.addEventListener('click', async () => {
  const name = prompt('Neighborhood name (e.g. 灏忕孩涔? 瀹炰範, 甯哥敤):');
  if (!name?.trim()) return;
  await addFolder(name.trim(), '');
  await renderBookmarksPanel();
});

// City map bookmark delegation 鈥?document-level so it works with dynamic HTML
document.addEventListener('click', async (e) => {
  const actionEl = e.target.closest('[data-action]');
  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === 'delete-folder') {
    e.stopPropagation();
    const id = actionEl.dataset.folderId;
    if (confirm('Delete this neighborhood and all its buildings?')) {
      await deleteFolder(id);
      await renderBookmarksPanel();
    }
    return;
  }

  if (action === 'add-link') {
    e.stopPropagation();
    const folderId = actionEl.dataset.folderId;
    const row = actionEl.closest('.add-building-row');
    const input = row?.querySelector('.add-building-input');
    const url = input?.value.trim();
    if (!url) return;
    const fullUrl = url.startsWith('http') ? url : 'https://' + url;
    let title = fullUrl;
    try { title = new URL(fullUrl).hostname.replace(/^www\./, ''); } catch {}
    await addLink(folderId, fullUrl, title);
    if (input) input.value = '';
    await renderBookmarksPanel();
    return;
  }

  if (action === 'delete-link') {
    e.stopPropagation();
    const { folderId, linkId } = actionEl.dataset;
    await deleteLink(folderId, linkId);
    await renderBookmarksPanel();
    return;
  }

  if (action === 'rename-link') {
    e.preventDefault();
    e.stopPropagation();
    const { folderId, linkId } = actionEl.dataset;
    const folders = await getFolders();
    const folder  = folders.find(f => f.id === folderId);
    const link    = folder?.links.find(l => l.id === linkId);
    if (!link) return;
    const newTitle = prompt('Rename:', link.title);
    if (newTitle?.trim()) {
      await renameLink(folderId, linkId, newTitle.trim());
      await renderBookmarksPanel();
    }
    return;
  }
});

// Enter key in add-building input
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.add-building-input');
  if (!input) return;
  const folderId = input.dataset.folderId;
  const url = input.value.trim();
  if (!url) return;
  const fullUrl = url.startsWith('http') ? url : 'https://' + url;
  let title = fullUrl;
  try { title = new URL(fullUrl).hostname.replace(/^www\./, ''); } catch {}
  await addLink(folderId, fullUrl, title);
  input.value = '';
  await renderBookmarksPanel();
});


/* ================================================================
   UTILITIES
   ================================================================ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ================================================================
   SITE CHARACTERS 鈥?custom SVG icons for known sites
   Replaces broken favicons with hand-drawn-style monochrome icons.
   Unknown domains fall back to a coloured letter tile.
   ================================================================ */

const AVATAR_COLORS = [
  '#C0392B','#8B6F47','#5A7268','#2C5F8A',
  '#6B4E8A','#3D7A5A','#8A4E3D','#5A5A7A',
];

function letterAvatarSvg(domain, size) {
  const clean  = (domain || 'x').replace(/^www\./, '');
  const letter = clean.charAt(0).toUpperCase();
  const code   = clean.charCodeAt(0);
  const bg     = AVATAR_COLORS[code % AVATAR_COLORS.length];
  const fs     = Math.round(size * 0.52);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${size}" height="${size}" rx="2" fill="${bg}"/>
    <text x="${size/2}" y="${size/2}" dominant-baseline="central" text-anchor="middle"
      fill="#fff" font-family="Space Mono,monospace" font-size="${fs}" font-weight="700">${letter}</text>
  </svg>`;
}

// Known-site character map.
// Each value is a function(size) 鈫?SVG string.
// Style: monochrome ink (#2C2C2C), simple line art, no fill except accents.
const SITE_CHARS = {
  // GitHub 鈥?minimalist cat silhouette
  'github.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C2C2C" stroke-width="1.4" stroke-linecap="round">
    <circle cx="10" cy="9" r="6"/>
    <path d="M6.5 4.5 Q5 2 4 2 Q4.5 4 5.5 5"/>
    <path d="M13.5 4.5 Q15 2 16 2 Q15.5 4 14.5 5"/>
    <path d="M7.5 11.5 Q10 14 12.5 11.5" stroke-width="1.2"/>
    <circle cx="8" cy="9.5" r="0.8" fill="#2C2C2C" stroke="none"/>
    <circle cx="12" cy="9.5" r="0.8" fill="#2C2C2C" stroke="none"/>
    <path d="M8 13 Q10 17 12 13" stroke-width="1"/>
  </svg>`,

  // YouTube 鈥?play button in rounded rect
  'youtube.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="5" width="16" height="10" rx="3" fill="none" stroke="#C0392B" stroke-width="1.4"/>
    <polygon points="8,7.5 14,10 8,12.5" fill="#C0392B" stroke="none"/>
  </svg>`,

  // Google 鈥?four coloured dots in a 2×2 grid
  'google.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <circle cx="7"  cy="7"  r="3.5" fill="#C0392B"/>
    <circle cx="13" cy="7"  r="3.5" fill="#8B6F47"/>
    <circle cx="7"  cy="13" r="3.5" fill="#5A7268"/>
    <circle cx="13" cy="13" r="3.5" fill="#2C5F8A"/>
  </svg>`,

  // Gmail 鈥?simple envelope
  'mail.google.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C2C2C" stroke-width="1.4">
    <rect x="2" y="5" width="16" height="11" rx="1.5"/>
    <path d="M2 6 L10 12 L18 6" stroke-width="1.2"/>
  </svg>`,

  // Figma 鈥?the classic four circles + one square
  'figma.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <circle cx="13" cy="10" r="3.5" fill="none" stroke="#5A7268" stroke-width="1.4"/>
    <rect x="3" y="3" width="7" height="7" rx="3.5" fill="none" stroke="#C0392B" stroke-width="1.4"/>
    <rect x="3" y="10" width="7" height="7" rx="0" fill="none" stroke="#8B6F47" stroke-width="1.4"/>
    <rect x="3" y="10" width="7" height="7" rx="3.5" fill="none" stroke="#2C5F8A" stroke-width="1.4"/>
  </svg>`,

  // Notion 鈥?simple block/page icon
  'notion.so': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C2C2C" stroke-width="1.4" stroke-linecap="round">
    <rect x="4" y="3" width="12" height="14" rx="1.5"/>
    <line x1="7" y1="7.5" x2="13" y2="7.5"/>
    <line x1="7" y1="10" x2="13" y2="10"/>
    <line x1="7" y1="12.5" x2="11" y2="12.5"/>
  </svg>`,

  // Twitter / X 鈥?bird or X mark
  'x.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" stroke="#2C2C2C" stroke-width="2" stroke-linecap="round">
    <line x1="4" y1="4" x2="16" y2="16"/>
    <line x1="16" y1="4" x2="4" y2="16"/>
  </svg>`,
  'twitter.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" stroke="#2C2C2C" stroke-width="2" stroke-linecap="round">
    <line x1="4" y1="4" x2="16" y2="16"/>
    <line x1="16" y1="4" x2="4" y2="16"/>
  </svg>`,

  // Reddit 鈥?alien antenna head
  'reddit.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#C0392B" stroke-width="1.4" stroke-linecap="round">
    <circle cx="10" cy="12" r="6"/>
    <circle cx="7.5" cy="11" r="1.2" fill="#C0392B" stroke="none"/>
    <circle cx="12.5" cy="11" r="1.2" fill="#C0392B" stroke="none"/>
    <path d="M7.5 14.5 Q10 16 12.5 14.5" stroke-width="1.2"/>
    <line x1="10" y1="6" x2="10" y2="3"/>
    <circle cx="10" cy="2.5" r="1" fill="#C0392B" stroke="none"/>
    <line x1="4" y1="10" x2="2" y2="8"/>
    <line x1="16" y1="10" x2="18" y2="8"/>
  </svg>`,

  // 灏忕孩涔?鈥?open book with a red cover
  'xiaohongshu.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke-linecap="round">
    <rect x="2" y="4" width="7" height="12" rx="1" fill="#C0392B" stroke="#8B1A1A" stroke-width="1"/>
    <rect x="11" y="4" width="7" height="12" rx="1" fill="none" stroke="#2C2C2C" stroke-width="1.2"/>
    <line x1="9" y1="4" x2="11" y2="4" stroke="#2C2C2C" stroke-width="1.2"/>
    <line x1="9" y1="16" x2="11" y2="16" stroke="#2C2C2C" stroke-width="1.2"/>
    <line x1="13" y1="8" x2="17" y2="8" stroke="#2C2C2C" stroke-width="1"/>
    <line x1="13" y1="10.5" x2="17" y2="10.5" stroke="#2C2C2C" stroke-width="1"/>
    <line x1="13" y1="13" x2="16" y2="13" stroke="#2C2C2C" stroke-width="1"/>
    <line x1="4" y1="8" x2="8" y2="8" stroke="#fff" stroke-width="1" opacity="0.6"/>
    <line x1="4" y1="10.5" x2="8" y2="10.5" stroke="#fff" stroke-width="1" opacity="0.6"/>
  </svg>`,

  // Claude 鈥?simple speech bubble
  'claude.ai': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#8B6F47" stroke-width="1.4" stroke-linecap="round">
    <path d="M3 4 Q3 2 5 2 H15 Q17 2 17 4 V12 Q17 14 15 14 H11 L7 17 V14 H5 Q3 14 3 12 Z"/>
    <line x1="7" y1="7" x2="13" y2="7" stroke-width="1.2"/>
    <line x1="7" y1="10" x2="11" y2="10" stroke-width="1.2"/>
  </svg>`,

  // ChatGPT 鈥?simple hexagon/gear
  'chatgpt.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#3D7A5A" stroke-width="1.4">
    <polygon points="10,2 16.5,5.5 16.5,13.5 10,17 3.5,13.5 3.5,5.5"/>
    <circle cx="10" cy="10" r="3"/>
  </svg>`,

  // LinkedIn 鈥?simple tie/briefcase
  'linkedin.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C5F8A" stroke-width="1.4" stroke-linecap="round">
    <rect x="3" y="7" width="5" height="10" rx="1"/>
    <circle cx="5.5" cy="4.5" r="2"/>
    <rect x="9" y="10" width="8" height="7" rx="1"/>
    <path d="M9 12 Q12 10 17 10"/>
  </svg>`,

  // Stack Overflow 鈥?stacked layers
  'stackoverflow.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#8B6F47" stroke-width="1.5" stroke-linecap="round">
    <rect x="4" y="13" width="12" height="2" rx="0"/>
    <line x1="4.5" y1="10.5" x2="15.5" y2="11.5"/>
    <line x1="5.5" y1="7.5"  x2="14.5" y2="9.5"/>
    <line x1="7"   y1="4.5"  x2="13"   y2="8"/>
  </svg>`,

  // Wikipedia 鈥?book with W
  'wikipedia.org': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C2C2C" stroke-width="1.4" stroke-linecap="round">
    <path d="M3 3 Q3 2 4 2 L10 4 L16 2 Q17 2 17 3 V15 Q17 16 16 16 L10 14 L4 16 Q3 16 3 15 Z"/>
    <text x="10" y="11" dominant-baseline="central" text-anchor="middle" fill="#2C2C2C" font-size="7" font-family="serif" stroke="none">W</text>
  </svg>`,

  // Bilibili 鈥?rabbit ears TV
  'bilibili.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#6B4E8A" stroke-width="1.4" stroke-linecap="round">
    <rect x="3" y="7" width="14" height="10" rx="2"/>
    <path d="M7 7 L5 3"/>
    <path d="M13 7 L15 3"/>
    <circle cx="7.5" cy="12" r="1.5" fill="#6B4E8A" stroke="none"/>
    <circle cx="12.5" cy="12" r="1.5" fill="#6B4E8A" stroke="none"/>
    <path d="M7.5 14.5 Q10 16 12.5 14.5" stroke-width="1.2"/>
  </svg>`,

  // Hacker News 鈥?a simple Y in a square
  'news.ycombinator.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
    <rect x="2" y="2" width="16" height="16" rx="2" fill="#C0392B"/>
    <text x="10" y="13" dominant-baseline="auto" text-anchor="middle" fill="#fff" font-size="11" font-family="monospace" font-weight="700" stroke="none">Y</text>
  </svg>`,

  // DeepSeek 鈥?eye / lens
  'deepseek.com': (s) => `<svg width="${s}" height="${s}" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="#2C5F8A" stroke-width="1.4" stroke-linecap="round">
    <path d="M2 10 Q6 4 10 4 Q14 4 18 10 Q14 16 10 16 Q6 16 2 10 Z"/>
    <circle cx="10" cy="10" r="3" stroke="#2C5F8A" stroke-width="1.4"/>
    <circle cx="10" cy="10" r="1.2" fill="#2C5F8A" stroke="none"/>
  </svg>`,
};

// Aliases for common subdomains
const SITE_CHAR_ALIASES = {
  'www.github.com':       'github.com',
  'www.youtube.com':      'youtube.com',
  'www.google.com':       'google.com',
  'www.figma.com':        'figma.com',
  'www.notion.so':        'notion.so',
  'www.x.com':            'x.com',
  'www.reddit.com':       'reddit.com',
  'old.reddit.com':       'reddit.com',
  'www.xiaohongshu.com':  'xiaohongshu.com',
  'www.claude.ai':        'claude.ai',
  'chat.openai.com':      'chatgpt.com',
  'www.chatgpt.com':      'chatgpt.com',
  'www.linkedin.com':     'linkedin.com',
  'www.stackoverflow.com':'stackoverflow.com',
  'en.wikipedia.org':     'wikipedia.org',
  'www.wikipedia.org':    'wikipedia.org',
  'www.bilibili.com':     'bilibili.com',
};

/**
 * siteIcon(domain, size, cssClass)
 * Returns an SVG site character for known domains,
 * or a coloured letter tile for unknown ones.
 */
function siteIcon(domain, size = 16, cssClass = '') {
  if (!domain) return '';
  const resolved = SITE_CHAR_ALIASES[domain] || domain;
  const renderer = SITE_CHARS[resolved];
  const svgStr   = renderer ? renderer(size) : letterAvatarSvg(domain, size);
  const cls = cssClass ? ` class="${cssClass}"` : '';
  return `<span${cls} style="display:inline-flex;flex-shrink:0;align-items:center;justify-content:center;width:${size}px;height:${size}px;">${svgStr}</span>`;
}

// Keep faviconImg as alias so existing calls still work
const faviconImg = (domain, size, cssClass) => siteIcon(domain, size, cssClass);


/* ================================================================
   HOVER PANEL 鈥?shows all tabs for a domain (鍥? label style)
   ================================================================ */

let hoverHideTimer = null;
let currentHoverGroup = null;

function showTabHoverPanel(buildingEl, event) {
  clearTimeout(hoverHideTimer);

  const panel = document.getElementById('tabHoverPanel');
  if (!panel) return;

  // Decode group data embedded in the building element
  let group;
  try { group = JSON.parse(decodeURIComponent(buildingEl.dataset.group)); }
  catch { return; }

  currentHoverGroup = group;

  // Populate panel
  document.getElementById('hoverPanelDomain').textContent = group.label || group.domain;
  document.getElementById('hoverPanelCount').textContent  = `${group.tabs.length} tab${group.tabs.length !== 1 ? 's' : ''}`;

  const tabsEl = document.getElementById('hoverPanelTabs');
  tabsEl.innerHTML = group.tabs.map(tab => {
    let domain = '';
    try { domain = new URL(tab.url).hostname; } catch {}
    const title = cleanTitle(smartTitle(stripTitleNoise(tab.title || ''), tab.url), domain);
    const safeUrl = (tab.url || '').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
    return `
      <div class="hover-panel-tab"
           data-action="focus-tab" data-tab-url="${safeUrl}">
        ${faviconImg(domain, 13, 'hover-panel-favicon')}
        <span class="hover-panel-title" title="${escapeHtml(title)}">${escapeHtml(title.slice(0, 50))}</span>
        <button class="hpt-action" data-action="close-single-tab" data-tab-url="${safeUrl}" title="Close">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>
        </button>
      </div>`;
  }).join('');

  // Position panel near building, avoid screen edges
  panel.classList.add('visible');
  const pr = panel.getBoundingClientRect();
  const br = buildingEl.getBoundingClientRect();

  let left = br.left + br.width / 2 - pr.width / 2;
  let top  = br.top - pr.height - 10;

  // Flip below if too high
  if (top < 8) top = br.bottom + 10;
  // Keep in viewport
  left = Math.max(8, Math.min(left, window.innerWidth - pr.width - 8));

  panel.style.left = left + 'px';
  panel.style.top  = top  + 'px';
}

function scheduleHoverPanelHide() {
  hoverHideTimer = setTimeout(() => {
    const panel = document.getElementById('tabHoverPanel');
    if (panel) panel.classList.remove('visible');
    currentHoverGroup = null;
  }, 200);
}

// Keep panel visible when mouse enters it
document.getElementById('tabHoverPanel')?.addEventListener('mouseenter', () => {
  clearTimeout(hoverHideTimer);
});

document.getElementById('tabHoverPanel')?.addEventListener('mouseleave', () => {
  scheduleHoverPanelHide();
});

// Hover panel footer: close all / save all for current group
document.getElementById('hoverCloseAll')?.addEventListener('click', async () => {
  if (!currentHoverGroup) return;
  const urls = currentHoverGroup.tabs.map(t => t.url);
  const useExact = currentHoverGroup.domain === '__landing-pages__' || !!currentHoverGroup.groupLabel;
  if (useExact) await closeTabsExact(urls);
  else          await closeTabsByUrls(urls);

  playCloseSound();
  document.getElementById('tabHoverPanel')?.classList.remove('visible');

  const closedLabel = currentHoverGroup?.label || currentHoverGroup?.domain || '';
  const staleId     = currentHoverGroup?.stableId;
  const el = staleId ? document.querySelector(`[data-domain-id="${staleId}"]`) : null;
  if (el) {
    const r = el.getBoundingClientRect();
    shootConfetti(r.left + r.width / 2, r.top + r.height / 2);
    el.style.transition = 'opacity 0.3s, transform 0.3s';
    el.style.opacity    = '0';
    el.style.transform  = 'translateY(-8px)';
    setTimeout(() => { el.remove(); checkAndShowEmptyState(); }, 300);
  }
  currentHoverGroup = null;
  await fetchOpenTabs();
  const realTabs = getRealTabs();
  const countEl = document.getElementById('sidebarTabCount');
  if (countEl) countEl.textContent = realTabs.length;
  showToast('Closed all tabs for ' + closedLabel);
});

document.getElementById('hoverSaveAll')?.addEventListener('click', async () => {
  if (!currentHoverGroup) return;
  for (const tab of currentHoverGroup.tabs) {
    await saveTabForLater({ url: tab.url, title: tab.title });
    const allTabs = await chrome.tabs.query({});
    const match   = allTabs.find(t => t.url === tab.url);
    if (match) await chrome.tabs.remove(match.id);
  }
  await fetchOpenTabs();
  document.getElementById('tabHoverPanel')?.classList.remove('visible');
  const el = document.querySelector(`[data-domain-id="${currentHoverGroup.stableId}"]`);
  if (el) { el.style.transition = 'opacity 0.3s'; el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }
  currentHoverGroup = null;
  await renderDeferredColumn();
  showToast('Saved for later');
});

// Make hover panel globally accessible (called from inline onmouseenter)
window.showTabHoverPanel    = showTabHoverPanel;
window.scheduleHoverPanelHide = scheduleHoverPanelHide;


/* ================================================================
   KEYBOARD SHORTCUTS
   ================================================================ */

async function getShortcuts() {
  const { shortcuts = [] } = await chrome.storage.local.get('shortcuts');
  return shortcuts;
}
async function saveShortcuts(s) { await chrome.storage.local.set({ shortcuts: s }); }

async function renderShortcutsPanel() {
  const panel = document.getElementById('shortcutsPanel');
  if (!panel) return;
  const shortcuts = await getShortcuts();
  if (shortcuts.length === 0) {
    panel.innerHTML = '<div style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--ink-muted);padding:8px 0;font-style:italic">No custom shortcuts yet.</div>';
    return;
  }
  panel.innerHTML = shortcuts.map(s => `
    <div class="shortcut-item">
      <span class="shortcut-key">${escapeHtml(s.key)}</span>
      <span class="shortcut-label">${escapeHtml(s.label || s.url)}</span>
      <button class="shortcut-delete" data-action="delete-shortcut"
              data-shortcut-key="${escapeHtml(s.key)}" title="Remove">×</button>
    </div>`).join('');
}

document.getElementById('addShortcutBtn')?.addEventListener('click', async () => {
  const key = prompt('鍗曞瓧姣嶅揩鎹烽敭 (e.g. g, n, r):')?.trim().slice(0, 1).toLowerCase();
  if (!key || !/[a-z0-9]/.test(key)) return;
  if ('htds'.includes(key)) { alert(`"${key.toUpperCase()}" is reserved (H/T/D/S = Home/Tabs/Todo/Settings).`); return; }
  const url = prompt('缃戝潃 (e.g. github.com):')?.trim();
  if (!url) return;
  const label = prompt('鏄剧ず鍚嶇О (鍙暀绌?:')?.trim() || url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  const shortcuts = await getShortcuts();
  const idx = shortcuts.findIndex(s => s.key === key);
  if (idx >= 0) shortcuts.splice(idx, 1);
  shortcuts.push({ key, url, label });
  await saveShortcuts(shortcuts);
  await renderShortcutsPanel();
  showToast(`Shortcut "${key.toUpperCase()}" 鈫?${label}`);
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="delete-shortcut"]');
  if (!btn) return;
  const key = btn.dataset.shortcutKey;
  const shortcuts = (await getShortcuts()).filter(s => s.key !== key);
  await saveShortcuts(shortcuts);
  await renderShortcutsPanel();
});

document.addEventListener('keydown', async (e) => {
  // Don't intercept when typing in inputs
  if (e.target.matches('input,textarea,[contenteditable]')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (key === 'h') { switchView('home'); return; }
  if (key === 't') { switchView('tabs'); return; }
  if (key === 'd') { switchView('todo'); return; }
  if (key === 's') { switchView('settings'); return; }
  // Custom shortcuts
  const shortcuts = await getShortcuts();
  const match = shortcuts.find(s => s.key === key);
  if (match) {
    const url = /^https?:\/\//.test(match.url) ? match.url : 'https://' + match.url;
    chrome.tabs.update({ url });
  }
});


/* ================================================================
   DRAG RECENT 鈫?PIN TO NEIGHBORHOOD
   ================================================================ */

document.addEventListener('dragstart', (e) => {
  const wrap = e.target.closest('.recent-item-wrap, .deferred-item, .pin-item');
  if (!wrap) return;
  e.dataTransfer.setData('application/json', JSON.stringify({
    url:   wrap.dataset.url,
    title: wrap.dataset.title,
  }));
  e.dataTransfer.effectAllowed = 'copy';
});

document.addEventListener('dragover', (e) => {
  const nbr = e.target.closest('.neighborhood');
  if (!nbr) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.querySelectorAll('.neighborhood.drag-over').forEach(n => n.classList.remove('drag-over'));
  nbr.classList.add('drag-over');
});

document.addEventListener('dragleave', (e) => {
  const nbr = e.target.closest('.neighborhood');
  if (nbr && !nbr.contains(e.relatedTarget)) nbr.classList.remove('drag-over');
});

document.addEventListener('drop', async (e) => {
  const nbr = e.target.closest('.neighborhood');
  if (!nbr) return;
  e.preventDefault();
  nbr.classList.remove('drag-over');
  let data;
  try { data = JSON.parse(e.dataTransfer.getData('application/json')); } catch { return; }
  if (!data?.url) return;
  const folderId = nbr.dataset.folderId;
  const fullUrl  = /^https?:\/\//.test(data.url) ? data.url : 'https://' + data.url;
  await addLink(folderId, fullUrl, data.title || fullUrl);
  await renderBookmarksPanel();
  showToast('Pinned to neighborhood');
});


/* ================================================================
   THREE-DOT MENU 鈥?pin recent item to a neighborhood
   ================================================================ */

let _pinUrl = null, _pinTitle = null;

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="open-recent-menu"]');
  const dropdown = document.getElementById('recentPinDropdown');
  if (!dropdown) return;

  if (btn) {
    e.stopPropagation();
    _pinUrl   = btn.dataset.url;
    _pinTitle = btn.dataset.title;
    const folders = await getFolders();
    const foldersEl = document.getElementById('rpdFolders');
    if (!foldersEl) return;
    foldersEl.innerHTML = folders.length
      ? folders.map(f =>
          `<button class="rpd-folder-btn" data-action="pin-to-folder"
                   data-folder-id="${f.id}">${escapeHtml(f.name)}</button>`
        ).join('')
      : `<span style="display:block;padding:8px 12px;font-family:'Space Mono',monospace;font-size:10px;color:var(--ink-muted)">No neighborhoods yet</span>`;
    const rect = btn.getBoundingClientRect();
    dropdown.style.display = 'block';
    dropdown.style.left = Math.min(rect.left, window.innerWidth - 180) + 'px';
    dropdown.style.top  = (rect.bottom + 6) + 'px';
    return;
  }

  if (!dropdown.contains(e.target)) dropdown.style.display = 'none';
});

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="pin-to-folder"]');
  if (!btn) return;
  e.stopPropagation();
  const folderId = btn.dataset.folderId;
  if (!_pinUrl || !folderId) return;
  const fullUrl = /^https?:\/\//.test(_pinUrl) ? _pinUrl : 'https://' + _pinUrl;
  await addLink(folderId, fullUrl, _pinTitle || fullUrl);
  document.getElementById('recentPinDropdown').style.display = 'none';
  await renderBookmarksPanel();
  showToast('Pinned to neighborhood');
  _pinUrl = _pinTitle = null;
});


/* ================================================================
   SCHEDULE 鈥?weekly grid with drag-from-todo
   ================================================================ */

async function getSchedule() {
  const { schedule = [] } = await chrome.storage.local.get('schedule');
  return schedule; // [{ todoId, date:'YYYY-MM-DD', hour:9 }]
}
async function saveSchedule(s) { await chrome.storage.local.set({ schedule: s }); }

async function scheduleItem(todoId, date, hour) {
  const s = await getSchedule();
  s.push({ todoId, date, hour });
  await saveSchedule(s);
}

async function unscheduleItem(todoId, date, hour) {
  const s = await getSchedule();
  await saveSchedule(s.filter(e => !(e.todoId === todoId && e.date === date && e.hour === hour)));
}

function dateKey(d) {
  return d.toISOString().slice(0, 10); // 'YYYY-MM-DD'
}

async function renderScheduleGrid() {
  const gridWrap = document.getElementById('scheduleGrid');
  const sidebarItems = document.getElementById('scheduleSidebarItems');
  if (!gridWrap) return;

  const [todos, schedule] = await Promise.all([getTodos(), getSchedule()]);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // 7 days from today
  const days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(d.getDate() + i);
    return d;
  });

  // Hours 7鈥?2
  const hours = Array.from({ length: 16 }, (_, i) => i + 7);

  // Build a lookup: "date_hour" 鈫?[{ todoId, text }]
  const slotMap = {};
  for (const entry of schedule) {
    const key = `${entry.date}_${entry.hour}`;
    if (!slotMap[key]) slotMap[key] = [];
    const todo = todos.find(t => t.id === entry.todoId);
    if (todo) slotMap[key].push({ todoId: entry.todoId, text: todo.text, url: todo.url, date: entry.date, hour: entry.hour });
  }

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // Header row
  const headerHtml = `
    <div class="sgh-corner"></div>
    ${days.map(d => {
      const isToday = dateKey(d) === dateKey(today);
      return `<div class="sgh-day${isToday ? ' today' : ''}">
        <div class="sgh-day-name">${DAY_NAMES[d.getDay()]}</div>
        <div class="sgh-day-date">${d.getDate()}</div>
      </div>`;
    }).join('')}`;

  // Body rows (one per hour)
  const bodyHtml = hours.map(h => {
    const timeLabel = `${String(h).padStart(2, '0')}:00`;
    const cells = days.map(d => {
      const dk = dateKey(d);
      const key = `${dk}_${h}`;
      const chips = (slotMap[key] || []).map(item => {
        const label = escapeHtml(item.text.slice(0, 20));
        const textEl = item.url
          ? `<a class="sc-chip-text sc-chip-link" href="${item.url.replace(/"/g,'&quot;')}" target="_top" title="${escapeHtml(item.text)}">${label}</a>`
          : `<span class="sc-chip-text" title="${escapeHtml(item.text)}">${label}</span>`;
        return `<div class="sc-chip">
          ${textEl}
          <button class="sc-chip-remove" data-action="unschedule-item"
                  data-todo-id="${item.todoId}" data-date="${item.date}" data-hour="${item.hour}">×</button>
        </div>`;
      }).join('');
      return `<div class="sg-cell" data-date="${dk}" data-hour="${h}">${chips}</div>`;
    }).join('');
    return `<div class="sg-time">${timeLabel}</div>${cells}`;
  }).join('');

  gridWrap.innerHTML = `<div class="schedule-grid">
    <div class="schedule-grid-header">${headerHtml}</div>
    ${bodyHtml}
  </div>`;

  // Sidebar: draggable todo pills
  if (sidebarItems) {
    sidebarItems.innerHTML = todos.length
      ? todos.map(t => `
          <div class="schedule-task-pill${t.done ? ' done-pill' : ''}"
               draggable="true" data-schedule-todo-id="${t.id}"
               data-schedule-todo-text="${escapeHtml(t.text)}">
            <div class="schedule-task-dot"></div>
            ${escapeHtml(t.text.slice(0, 30))}
          </div>`).join('')
      : `<div style="font-family:'Space Mono',monospace;font-size:10px;color:var(--ink-muted);padding:12px;font-style:italic">No tasks yet</div>`;
  }
}

// Drag from sidebar pills 鈫?schedule cells
document.addEventListener('dragstart', (e) => {
  const pill = e.target.closest('.schedule-task-pill');
  if (!pill) return;
  e.dataTransfer.setData('application/schedule-todo', JSON.stringify({
    todoId: pill.dataset.scheduleTodoId,
    text:   pill.dataset.scheduleTodoText,
  }));
  e.dataTransfer.effectAllowed = 'copy';
});

document.addEventListener('dragover', (e) => {
  const cell = e.target.closest('.sg-cell');
  if (!cell) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  document.querySelectorAll('.sg-cell.drag-over-cell').forEach(c => c.classList.remove('drag-over-cell'));
  cell.classList.add('drag-over-cell');
});

document.addEventListener('dragleave', (e) => {
  const cell = e.target.closest('.sg-cell');
  if (cell && !cell.contains(e.relatedTarget)) cell.classList.remove('drag-over-cell');
});

document.addEventListener('drop', async (e) => {
  const cell = e.target.closest('.sg-cell');
  if (!cell) return;
  // Only handle schedule drops (not recent鈫抧eighborhood drops which use 'application/json')
  const raw = e.dataTransfer.getData('application/schedule-todo');
  if (!raw) return;
  e.preventDefault();
  cell.classList.remove('drag-over-cell');
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  const { date, hour } = cell.dataset;
  await scheduleItem(data.todoId, date, parseInt(hour));
  await renderScheduleGrid();
});

// Remove scheduled item from cell
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="unschedule-item"]');
  if (!btn) return;
  e.stopPropagation();
  const { todoId, date, hour } = btn.dataset;
  await unscheduleItem(todoId, date, parseInt(hour));
  await renderScheduleGrid();
});

// Double-click schedule grid 鈥?edit chip text or create new task in empty cell
document.addEventListener('dblclick', async (e) => {
  // 鈹€鈹€ Case 1: double-click on an existing chip text 鈫?inline edit 鈹€鈹€
  const chip = e.target.closest('.sc-chip');
  if (chip) {
    e.stopPropagation();
    const textEl = chip.querySelector('.sc-chip-text');
    if (!textEl) return;
    const removeBtn = chip.querySelector('.sc-chip-remove');
    const todoId = removeBtn?.dataset.todoId;
    const current = textEl.textContent.trim();

    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'sc-chip-edit-input';
    textEl.replaceWith(input);
    input.focus();
    input.select();

    async function commitChipEdit() {
      const newText = input.value.trim();
      if (newText && newText !== current && todoId) {
        const todos = await getTodos();
        const t = todos.find(t => t.id === todoId);
        if (t) { t.text = newText; await saveTodos(todos); }
      }
      await renderScheduleGrid();
      if (document.getElementById('todoTabList')?.style.display !== 'none') renderTodoPanel();
    }

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter')  { ev.preventDefault(); commitChipEdit(); }
      if (ev.key === 'Escape') renderScheduleGrid();
    });
    input.addEventListener('blur', commitChipEdit);
    return;
  }

  // 鈹€鈹€ Case 2: double-click on empty cell 鈫?inline create new task 鈹€鈹€
  const cell = e.target.closest('.sg-cell');
  if (!cell) return;
  // Don't open a second editor if one already exists
  if (cell.querySelector('.sc-new-input')) return;

  const { date, hour } = cell.dataset;

  const wrapper = document.createElement('div');
  wrapper.className = 'sc-chip sc-chip-new';
  wrapper.innerHTML = `<input class="sc-chip-edit-input sc-new-input" type="text" placeholder="new task鈥?>`;
  cell.appendChild(wrapper);

  const input = wrapper.querySelector('input');
  input.focus();

  async function commitNewTask() {
    const text = input.value.trim();
    wrapper.remove();
    if (!text) return;
    // Create todo then schedule it
    const id = Date.now().toString();
    const todos = await getTodos();
    todos.push({ id, text, done: false, createdAt: new Date().toISOString() });
    await saveTodos(todos);
    await scheduleItem(id, date, parseInt(hour));
    await renderScheduleGrid();
    await renderTodoPanel();
  }

  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  { ev.preventDefault(); commitNewTask(); }
    if (ev.key === 'Escape') { wrapper.remove(); }
  });
  input.addEventListener('blur', commitNewTask);
});

// Todo list / schedule tab toggle
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.todo-tab-btn');
  if (!btn) return;
  const tab = btn.dataset.todoTab;
  document.querySelectorAll('.todo-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  document.getElementById('todoTabList').style.display     = tab === 'list'     ? '' : 'none';
  document.getElementById('todoTabSchedule').style.display = tab === 'schedule' ? '' : 'none';
  if (tab === 'schedule') renderScheduleGrid();
});


/* ================================================================
   TIME FILTER 鈥?recent history (鍥? segmented control)
   ================================================================ */

document.querySelectorAll('.time-filter-btn').forEach(btn => {
  btn.addEventListener('click', async () => {
    // Update active state
    document.querySelectorAll('.time-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    await renderRecentHistory(btn.dataset.time);
  });
});


/* ================================================================
   STICK FIGURE CURSOR
   ================================================================ */

(function initStickFigure() {
  const fig = document.getElementById('stick-figure');
  if (!fig) return;

  // Smooth lag 鈥?figure trails behind cursor slightly
  let tx = window.innerWidth / 2, ty = window.innerHeight / 2;
  let cx = tx, cy = ty;
  let lastTx = tx;
  let facing = 1; // 1 = right, -1 = left

  document.addEventListener('mousemove', e => {
    facing = e.clientX >= lastTx ? 1 : -1;
    lastTx = e.clientX;
    tx = e.clientX;
    ty = e.clientY;
  });

  function tick() {
    // Ease toward target
    cx += (tx - cx) * 0.12;
    cy += (ty - cy) * 0.12;
    fig.style.left = cx + 'px';
    fig.style.top  = cy + 'px';
    fig.style.transform = `translate(-10px, -28px) scaleX(${facing})`;
    requestAnimationFrame(tick);
  }
  tick();
})();


/* ================================================================
   SAVED PINS 鈥?quick-bookmark any page with one click
   ================================================================ */

async function getPins() {
  const { pins = [] } = await chrome.storage.sync.get('pins');
  return pins;
}
async function savePins(pins) {
  await chrome.storage.sync.set({ pins });
}

async function markPinRead(pinId) {
  const pins = await getPins();
  const p = pins.find(p => p.id === pinId);
  if (p && !p.read) { p.read = true; await savePins(pins); }
}

async function renderPinsPanel() {
  const container = document.getElementById('pinsPanel');
  if (!container) return;
  const pins = await getPins();

  // Unread bar
  const bar = document.getElementById('pinsUnreadBar');
  const unreadCount = pins.filter(p => !p.read).length;
  if (bar) {
    if (unreadCount > 0) {
      bar.style.display = 'block';
      bar.textContent = `${unreadCount} unread`;
    } else {
      bar.style.display = 'none';
    }
  }

  if (pins.length === 0) {
    container.innerHTML = `<div class="pins-empty">Nothing saved yet — press Alt+S on any page to save it here.</div>`;
    return;
  }
  container.innerHTML = pins.map(p => {
    let domain = '';
    try { domain = new URL(p.url).hostname; } catch {}
    const unreadDot = p.read ? '' : `<span class="pin-unread-dot"></span>`;
    const safeUrl   = p.url.replace(/"/g,'&quot;');
    const safeTitle = (p.title || p.url).replace(/"/g,'&quot;');
    return `<div class="pin-item${p.read ? ' pin-read' : ''}" data-pin-id="${p.id}"
         draggable="true" data-url="${safeUrl}" data-title="${safeTitle}">
      ${unreadDot}
      ${faviconImg(domain, 14, 'pin-favicon')}
      <a class="pin-title" href="${safeUrl}" target="_top"
         title="Double-click to rename">${escapeHtml(p.title || p.url)}</a>
      <button class="pin-action-btn" data-action="delete-pin" data-pin-id="${p.id}" title="Remove">×</button>
    </div>`;
  }).join('');
}

/* Re-render pins when background saves via Alt+S */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.pins) renderPinsPanel();
});

/* Right-click on pin item 鈫?"pin to todo" context menu */
(function initPinContextMenu() {
  // Create the menu element once
  const menu = document.createElement('div');
  menu.id = 'pinContextMenu';
  menu.className = 'pin-context-menu';
  menu.innerHTML = `
    <button class="pin-ctx-btn" id="pinCtxRename">✎ rename</button>
    <button class="pin-ctx-btn" id="pinCtxTodo">📌 pin to todo</button>
  `;
  document.body.appendChild(menu);

  let activePinId = null;

  function hideMenu() { menu.style.display = 'none'; activePinId = null; }

  document.addEventListener('contextmenu', (e) => {
    const item = e.target.closest('.pin-item');
    if (!item) return;
    e.preventDefault();
    activePinId = item.dataset.pinId;
    menu.style.display = 'block';
    menu.style.left = e.clientX + 'px';
    menu.style.top  = e.clientY + 'px';
  });

  document.getElementById('pinCtxRename').addEventListener('click', async () => {
    if (!activePinId) return;
    const id = activePinId; // capture before hideMenu clears it
    hideMenu();
    const titleEl = document.querySelector(`.pin-item[data-pin-id="${id}"] .pin-title`);
    if (titleEl) titleEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  });

  document.getElementById('pinCtxTodo').addEventListener('click', async () => {
    if (!activePinId) return;
    const pins = await getPins();
    const pin  = pins.find(p => p.id === activePinId);
    if (pin) {
      await addTodo(pin.title, pin.url, pin.id);
      await renderTodoPanel();
      showToast('Added to todo list');
    }
    hideMenu();
  });

  document.addEventListener('click', (e) => {
    if (!menu.contains(e.target)) hideMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
})();

/* Delete pin via event delegation */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action="delete-pin"]');
  if (!btn) return;
  const id = btn.dataset.pinId;
  const pins = (await getPins()).filter(p => p.id !== id);
  await savePins(pins);
  await renderPinsPanel();
});

/* Double-click on pin title to rename inline */
document.addEventListener('dblclick', async (e) => {
  const a = e.target.closest('.pin-title');
  if (!a) return;
  const item = a.closest('.pin-item');
  if (!item) return;
  const id      = item.dataset.pinId;
  const current = a.textContent;

  const input = document.createElement('input');
  input.type      = 'text';
  input.value     = current;
  input.className = 'pin-rename-input';
  a.replaceWith(input);
  input.focus();
  input.select();

  async function commitRename() {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== current) {
      const pins = await getPins();
      const p = pins.find(p => p.id === id);
      if (p) { p.title = newTitle; await savePins(pins); }
    }
    await renderPinsPanel();
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitRename();
    if (e.key === 'Escape') renderPinsPanel();
  });
  input.addEventListener('blur', commitRename);
});


/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */
async function init() {
  const greetingEl = document.getElementById('greeting');
  const dateEl = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl) dateEl.textContent = getDateDisplay();

  await Promise.all([
    renderDashboard(),
    renderTodoPanel(),
    renderScheduleGrid(),
    renderBookmarksPanel(),
    renderRecentHistory(),
    renderShortcutsPanel(),
    renderFrequentSites(),
    renderPinsPanel(),
  ]);
}

init();



