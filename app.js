/**
 * Random YouTube Video Picker
 *
 * Resolves a channel, pages its entire "uploads" playlist through the YouTube
 * Data API v3, caches the result locally, and rolls a random video from it.
 * No build step, no server, no dependencies.
 */

const API = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;   // re-fetch a catalog after 12h
const MAX_REMEMBERED = 10;                  // channel chips kept
const MAX_PAGES = 400;                      // safety net: 400 pages = 20k videos

const K = {
  apiKey: 'ytr:apiKey',
  channels: 'ytr:channels',
  lastChannel: 'ytr:lastChannelId',
  catalog: id => `ytr:catalog:${id}`,
  recent: id => `ytr:recent:${id}`,
};

const $ = id => document.getElementById(id);
const el = {
  setup: $('setup'), keyForm: $('key-form'), keyInput: $('key-input'),
  picker: $('picker'), channelForm: $('channel-form'), channelInput: $('channel-input'),
  chips: $('chips'),
  status: $('status'), error: $('error'),
  stage: $('stage'), channelTitle: $('channel-title'), catalogInfo: $('catalog-info'),
  refreshBtn: $('refresh-btn'), rollBtn: $('roll-btn'),
  result: $('result'), player: $('player'), videoTitle: $('video-title'),
  videoDate: $('video-date'), videoLink: $('video-link'),
  forgetKey: $('forget-key'),
};

/** Current channel: { id, title, uploadsPlaylistId, videos: [{id,title,publishedAt}] } */
let current = null;
/** Session fallback for catalogs too large to persist. */
const memoryCatalogs = new Map();
let busy = false;

/* ───────────────────────── storage helpers ───────────────────────── */
// Private browsing / disabled storage must degrade to "forgetful", not "broken".

function readRaw(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeRaw(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}
function removeRaw(key) {
  try { localStorage.removeItem(key); } catch { /* ignore */ }
}
function readJSON(key, fallback) {
  const raw = readRaw(key);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}
function writeJSON(key, value) {
  return writeRaw(key, JSON.stringify(value));
}

/* ───────────────────────── API plumbing ──────────────────────────── */

function apiKey() {
  return readRaw(K.apiKey) || '';
}

/** One API call. Throws an ApiError carrying a human-readable message. */
async function api(path, params) {
  const url = new URL(`${API}/${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  url.searchParams.set('key', apiKey());

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new ApiError('Could not reach YouTube. Check your internet connection.');
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(explainApiError(res.status, body), body);
  return body;
}

class ApiError extends Error {
  constructor(message, body) { super(message); this.name = 'ApiError'; this.body = body; }
}

/** Turn Google's error payloads into something actionable. */
function explainApiError(status, body) {
  const err = body?.error || {};
  const reason = err.errors?.[0]?.reason || '';

  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return 'This API key has used up its daily YouTube quota (it resets at midnight ' +
           'Pacific Time). Cached channels still work — try rolling without refreshing.';
  }
  if (reason === 'keyInvalid' || (reason === 'badRequest' && /API key/i.test(err.message || ''))) {
    return 'That API key is not valid. Check it for typos, or create a new one.';
  }
  if (status === 403 && (reason === 'forbidden' || reason === 'accessNotConfigured')) {
    return 'YouTube rejected the key. The two usual causes: the "YouTube Data API v3" is ' +
           'not enabled for the key\'s Google Cloud project, or the key\'s HTTP referrer ' +
           'restriction does not include this page\'s address.';
  }
  if (status === 400) {
    return `YouTube rejected the request: ${err.message || 'bad request'}`;
  }
  return `YouTube returned an error (${status})${err.message ? `: ${err.message}` : ''}.`;
}

/* ───────────────────── channel resolution ────────────────────────── */

/** Classify whatever the user pasted. */
function parseChannelInput(raw) {
  const input = raw.trim();
  if (!input) return null;

  // Bare channel ID.
  if (/^UC[\w-]{22}$/.test(input)) return { kind: 'id', value: input };
  // Bare handle.
  if (/^@[\w.\-]+$/.test(input)) return { kind: 'handle', value: input };

  // A URL (with or without scheme).
  let url = null;
  try {
    url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  } catch { /* not a URL */ }

  if (url && /(^|\.)(youtube\.com|youtu\.be)$/i.test(url.hostname)) {
    const segments = url.pathname.split('/').filter(Boolean);
    const [first, second] = segments;
    if (first?.startsWith('@')) return { kind: 'handle', value: first };
    if (first === 'channel' && second) return { kind: 'id', value: second };
    if (first === 'user' && second) return { kind: 'username', value: second };
    if (first === 'c' && second) return { kind: 'search', value: decodeURIComponent(second) };
    if (first) return { kind: 'search', value: decodeURIComponent(first) };
  }

  // Anything else: treat as a name to search for.
  return { kind: 'search', value: input };
}

/** Resolve user input to { id, title, uploadsPlaylistId }. */
async function resolveChannel(raw) {
  const parsed = parseChannelInput(raw);
  if (!parsed) throw new ApiError('Enter a channel handle, URL, or ID.');

  const part = 'snippet,contentDetails';
  let data;

  switch (parsed.kind) {
    case 'id':
      data = await api('channels', { part, id: parsed.value });
      break;
    case 'handle':
      data = await api('channels', { part, forHandle: parsed.value });
      break;
    case 'username':
      data = await api('channels', { part, forUsername: parsed.value });
      // Legacy usernames often no longer resolve; fall back to search.
      if (!data.items?.length) data = null;
      break;
  }

  if (!data?.items?.length) {
    // Search fallback (costs 100 quota units — see README).
    const hit = await api('search', {
      part: 'snippet', type: 'channel', maxResults: 1, q: parsed.value,
    });
    const channelId = hit.items?.[0]?.snippet?.channelId || hit.items?.[0]?.id?.channelId;
    if (!channelId) {
      throw new ApiError(`No channel found for “${parsed.value}”. Try pasting the channel's URL.`);
    }
    data = await api('channels', { part, id: channelId });
  }

  const item = data.items?.[0];
  if (!item) throw new ApiError(`No channel found for “${parsed.value}”.`);

  const uploads = item.contentDetails?.relatedPlaylists?.uploads;
  if (!uploads) {
    throw new ApiError(`“${item.snippet?.title || parsed.value}” has no public uploads playlist.`);
  }

  return {
    id: item.id,
    title: item.snippet?.title || parsed.value,
    uploadsPlaylistId: uploads,
  };
}

/* ─────────────────────── catalog fetching ────────────────────────── */

/** Page the uploads playlist to completion. 1 quota unit per 50 videos. */
async function fetchCatalog(uploadsPlaylistId, onProgress) {
  const videos = [];
  let pageToken;
  let pages = 0;

  do {
    const page = await api('playlistItems', {
      part: 'snippet,contentDetails',
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of page.items || []) {
      const id = item.contentDetails?.videoId;
      // Private/deleted entries linger in uploads playlists without a publish date.
      if (!id || !item.contentDetails?.videoPublishedAt) continue;
      videos.push({
        id,
        title: item.snippet?.title || 'Untitled',
        publishedAt: item.contentDetails.videoPublishedAt,
      });
    }

    onProgress?.(videos.length);
    pageToken = page.nextPageToken;
  } while (pageToken && ++pages < MAX_PAGES);

  return videos;
}

function loadCachedCatalog(channelId) {
  if (memoryCatalogs.has(channelId)) return memoryCatalogs.get(channelId);
  const cached = readJSON(K.catalog(channelId), null);
  if (!cached?.videos?.length) return null;
  return cached;
}

function saveCatalog(channel, videos) {
  const payload = { channelTitle: channel.title, fetchedAt: Date.now(), videos };
  memoryCatalogs.set(channel.id, payload);
  if (!writeJSON(K.catalog(channel.id), payload)) {
    // Storage full or unavailable — the in-memory copy carries this session.
    return false;
  }
  return true;
}

/* ──────────────────── remembered channels ────────────────────────── */

function rememberedChannels() {
  const list = readJSON(K.channels, []);
  return Array.isArray(list) ? list.filter(c => c && c.id && c.title) : [];
}

function rememberChannel(channel) {
  const list = rememberedChannels().filter(c => c.id !== channel.id);
  list.unshift({
    id: channel.id,
    title: channel.title,
    uploadsPlaylistId: channel.uploadsPlaylistId,
    lastUsedAt: Date.now(),
  });
  for (const dropped of list.slice(MAX_REMEMBERED)) forgetChannelData(dropped.id);
  writeJSON(K.channels, list.slice(0, MAX_REMEMBERED));
  writeRaw(K.lastChannel, channel.id);
  renderChips();
}

function forgetChannelData(channelId) {
  removeRaw(K.catalog(channelId));
  removeRaw(K.recent(channelId));
  memoryCatalogs.delete(channelId);
}

function forgetChannel(channelId) {
  writeJSON(K.channels, rememberedChannels().filter(c => c.id !== channelId));
  forgetChannelData(channelId);
  if (readRaw(K.lastChannel) === channelId) removeRaw(K.lastChannel);
  if (current?.id === channelId) {
    current = null;
    el.stage.hidden = true;
    el.result.hidden = true;
    el.player.src = '';
  }
  renderChips();
}

function renderChips() {
  const list = rememberedChannels();
  el.chips.replaceChildren();
  el.chips.hidden = list.length === 0;

  for (const channel of list) {
    const chip = document.createElement('span');
    chip.className = 'chip' + (current?.id === channel.id ? ' active' : '');

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'chip-name';
    name.textContent = channel.title;
    name.title = `Load ${channel.title}`;
    name.addEventListener('click', () => selectChannel(channel));

    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'chip-x';
    x.textContent = '×';
    x.title = `Forget ${channel.title}`;
    x.setAttribute('aria-label', `Forget ${channel.title}`);
    x.addEventListener('click', () => forgetChannel(channel.id));

    chip.append(name, x);
    el.chips.append(chip);
  }
}

/* ────────────────────────── the roll ─────────────────────────────── */

function randomIndex(max) {
  if (max <= 0) return 0;
  // Rejection sampling keeps the distribution uniform.
  const limit = Math.floor(0xffffffff / max) * max;
  const buf = new Uint32Array(1);
  let n;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= limit);
  return n % max;
}

function recentlyShown(channelId) {
  const list = readJSON(K.recent(channelId), []);
  return Array.isArray(list) ? list : [];
}

function noteShown(channelId, videoId, catalogSize) {
  const keep = Math.max(1, Math.min(25, Math.floor(catalogSize / 4)));
  const list = [videoId, ...recentlyShown(channelId).filter(id => id !== videoId)].slice(0, keep);
  writeJSON(K.recent(channelId), list);
}

function roll() {
  if (!current?.videos?.length) return;

  const seen = new Set(recentlyShown(current.id));
  let pool = current.videos.filter(v => !seen.has(v.id));
  if (!pool.length) {
    // Everything in the buffer — start a fresh cycle.
    removeRaw(K.recent(current.id));
    pool = current.videos;
  }

  const video = pool[randomIndex(pool.length)];
  noteShown(current.id, video.id, current.videos.length);
  showVideo(video);
}

function showVideo(video) {
  el.player.src = `https://www.youtube-nocookie.com/embed/${video.id}?autoplay=1&rel=0`;
  el.videoTitle.textContent = video.title;
  el.videoDate.textContent = formatDate(video.publishedAt);
  el.videoLink.href = `https://www.youtube.com/watch?v=${video.id}`;
  el.result.hidden = false;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/* ────────────────────── loading a channel ────────────────────────── */

/**
 * Load a channel into the stage.
 * @param {{id:string,title:string,uploadsPlaylistId?:string}} channel
 * @param {{forceRefresh?:boolean}} [opts]
 */
async function selectChannel(channel, { forceRefresh = false } = {}) {
  if (busy) return;
  clearError();

  const cached = forceRefresh ? null : loadCachedCatalog(channel.id);
  const fresh = cached && (Date.now() - (cached.fetchedAt || 0) < CACHE_TTL_MS);

  // Show the cached catalog immediately, even if it is stale — a stale roll now
  // beats a spinner, and the refresh below swaps the list in when it lands.
  if (cached) {
    current = { ...channel, title: cached.channelTitle || channel.title, videos: cached.videos };
    showStage(cached.fetchedAt);
    writeRaw(K.lastChannel, channel.id);
    renderChips();
    if (fresh) return;
  }

  setBusy(true);
  try {
    let uploads = channel.uploadsPlaylistId;
    let title = channel.title;

    if (!uploads) {
      setStatus('Looking up channel…');
      const resolved = await resolveChannel(channel.id);
      uploads = resolved.uploadsPlaylistId;
      title = resolved.title;
      channel = { ...channel, ...resolved };
    }

    setStatus(cached ? 'Checking for new videos…' : 'Loading video list…');
    const videos = await fetchCatalog(uploads, count => {
      setStatus(`Loaded ${count} video${count === 1 ? '' : 's'}…`);
    });

    if (!videos.length) {
      throw new ApiError(`“${title}” has no public videos to pick from.`);
    }

    const resolvedChannel = { id: channel.id, title, uploadsPlaylistId: uploads };
    const persisted = saveCatalog(resolvedChannel, videos);
    current = { ...resolvedChannel, videos };
    rememberChannel(resolvedChannel);
    showStage(Date.now(), persisted ? '' : ' · too large to save, will reload next visit');
  } catch (err) {
    // A failed refresh must not blow away a usable cached catalog.
    if (cached && current?.id === channel.id) {
      showError(err, 'Showing the previously saved video list instead.');
    } else {
      showError(err);
    }
  } finally {
    setBusy(false);
    setStatus('');
  }
}

function showStage(fetchedAt, note = '') {
  el.stage.hidden = false;
  el.channelTitle.textContent = current.title;
  const count = current.videos.length.toLocaleString();
  el.catalogInfo.textContent =
    `${count} video${current.videos.length === 1 ? '' : 's'} · list saved ${relativeTime(fetchedAt)}${note}`;
  renderChips();
}

function relativeTime(timestamp) {
  if (!timestamp) return 'just now';
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/* ────────────────────────── UI plumbing ──────────────────────────── */

function setBusy(value) {
  busy = value;
  el.rollBtn.disabled = value;
  el.refreshBtn.disabled = value;
  el.channelForm.querySelector('button').disabled = value;
}

function setStatus(text) {
  el.status.textContent = text;
  el.status.hidden = !text;
}

function showError(err, extra = '') {
  const message = err instanceof ApiError ? err.message
    : (err?.message || 'Something went wrong.');
  el.error.replaceChildren();
  for (const line of [message, extra].filter(Boolean)) {
    const p = document.createElement('p');
    p.textContent = line;
    el.error.append(p);
  }
  el.error.hidden = false;
  if (!(err instanceof ApiError)) console.error(err);
}

function clearError() {
  el.error.hidden = true;
  el.error.replaceChildren();
}

function showKeyGate(show) {
  el.setup.hidden = !show;
  el.picker.hidden = show;
  el.forgetKey.hidden = show;
  if (show) {
    el.stage.hidden = true;
    el.result.hidden = true;
    el.player.src = '';
  }
}

/* ─────────────────────────── wiring ──────────────────────────────── */

el.keyForm.addEventListener('submit', event => {
  event.preventDefault();
  const key = el.keyInput.value.trim();
  if (!key) return;
  if (!writeRaw(K.apiKey, key)) {
    showError(new ApiError(
      'This browser is blocking local storage, so the key cannot be saved. ' +
      'Private browsing mode is the usual cause.'));
    return;
  }
  el.keyInput.value = '';
  clearError();
  showKeyGate(false);
  renderChips();
  el.channelInput.focus();
});

el.channelForm.addEventListener('submit', event => {
  event.preventDefault();
  const raw = el.channelInput.value.trim();
  if (!raw || busy) return;
  clearError();
  setBusy(true);

  resolveChannel(raw)
    .then(channel => {
      el.channelInput.value = '';
      setBusy(false);
      return selectChannel(channel, { forceRefresh: true });
    })
    .catch(err => { showError(err); setBusy(false); setStatus(''); });
});

el.rollBtn.addEventListener('click', roll);

el.refreshBtn.addEventListener('click', () => {
  if (current) selectChannel(current, { forceRefresh: true });
});

el.forgetKey.addEventListener('click', () => {
  removeRaw(K.apiKey);
  current = null;
  clearError();
  showKeyGate(true);
});

/* ─────────────────────────── startup ─────────────────────────────── */

(function init() {
  if (!apiKey()) {
    showKeyGate(true);
    return;
  }
  showKeyGate(false);
  renderChips();

  const lastId = readRaw(K.lastChannel);
  const remembered = rememberedChannels().find(c => c.id === lastId);
  if (remembered) {
    selectChannel(remembered);
  } else {
    el.channelInput.focus();
  }
})();
