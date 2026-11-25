// depth3d Bilibili plugin (protocol v1)
//
// Public browsing and playback work without an account. QR login additionally
// unlocks watch history, favorites, progress sync, login-only qualities and
// subtitles.
//
// Design notes:
// - Every Bilibili API is called through ctx.fetch with a browser User-Agent
//   and Referer. Bilibili image and m4s URLs are rejected with 403 without the
//   Referer, so images carry headers and DASH tracks rely on PlaybackInfo.headers.
// - Login cookies live only in ctx.storage and are never logged, returned in
//   titles/descriptions, or attached to CDN stream requests.
// - Bilibili answers HTTP 200 with a business code; every non-zero code is
//   mapped to a protocol error instead of silently returning an empty list.
// - The WBI signature (w_rid/wts) is required by playurl and search; it is
//   derived from /x/web-interface/nav as documented by bilibili-API-collect and
//   implemented by third-party clients such as BBDown.
// - Danmaku is intentionally not implemented: x/v1/dm/list.so always returns
//   deflate-compressed XML and the sandbox has no inflate primitive.

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REFERER = 'https://www.bilibili.com/';
const SEARCH_REFERER = 'https://search.bilibili.com/';
const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';
const SUGGEST_API = 'https://s.search.bilibili.com';

const PAGE_SIZE = 20;
const MAX_SEARCH_PAGE = 50;
const CACHE_MAX = 64;
const META_TTL_MS = 30 * 60 * 1000;
const FAV_TTL_MS = 10 * 60 * 1000;
const PLAY_URL_TTL_MS = 90 * 60 * 1000;

const QN_BY_CONFIG = { auto: 80, '1080': 80, '720': 64, '480': 32, '360': 16 };
const QUALITY_LABELS = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: '杜比视界',
  127: '8K',
};
const AUDIO_LABELS = {
  30216: '64K',
  30232: '132K',
  30280: '192K',
  30250: '杜比全景声',
  30251: 'Hi-Res 无损',
};

// Bilibili's stable WBI mixin-key permutation table (see bilibili-API-collect).
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

// Main UGC partitions served by x/web-interface/newlist.
const REGIONS = [
  { rid: 1, title: '动画' },
  { rid: 3, title: '音乐' },
  { rid: 4, title: '游戏' },
  { rid: 5, title: '娱乐' },
  { rid: 36, title: '知识' },
  { rid: 188, title: '科技' },
  { rid: 181, title: '影视' },
  { rid: 23, title: '电影' },
  { rid: 11, title: '电视剧' },
  { rid: 177, title: '纪录片' },
  { rid: 71, title: '综艺' },
  { rid: 129, title: '舞蹈' },
  { rid: 119, title: '鬼畜' },
  { rid: 160, title: '生活' },
];

const cache = new Map();
let wbiKey = null;

/* ------------------------------------------------------------------ */
/* small utilities                                                     */
/* ------------------------------------------------------------------ */

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > entry.ttl) {
    cache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheSet(key, value, ttl = META_TTL_MS) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { at: Date.now(), ttl, value });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

function pathOf(url) {
  const s = String(url || '');
  const idx = s.indexOf('?');
  return idx >= 0 ? s.slice(0, idx) : s;
}

function cleanText(value) {
  return String(value == null ? '' : value)
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function httpsUrl(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (s.startsWith('//')) return `https:${s}`;
  if (/^http:\/\//i.test(s)) return s.replace(/^http:/i, 'https:');
  if (/^https:\/\//i.test(s)) return s;
  return '';
}

function image(value) {
  const url = httpsUrl(value);
  if (!url) return undefined;
  return { url, headers: { Referer: REFERER } };
}

// The wall keys each row and card by item id, so the same id twice in one
// response crashes its list. Bilibili does return duplicates (search results,
// multi-page feeds), so every list handed to the host is deduplicated.
function uniqueById(items) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (!item || !item.id || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 100000000) return `${(n / 100000000).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1).replace(/\.0$/, '')}万`;
  return String(n);
}

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = h > 0 && m < 10 ? `0${m}` : String(m);
  const ss = s < 10 ? `0${s}` : String(s);
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function parseDurationText(value) {
  const s = String(value || '').trim();
  if (!s) return 0;
  if (/^\d+$/.test(s)) return Number(s) * 1000;
  const parts = s.split(':').map((p) => Number(p) || 0);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return 0;
}

function yearOf(timestamp) {
  const n = Number(timestamp) || 0;
  if (n <= 0) return undefined;
  const year = new Date(n * 1000).getFullYear();
  return year >= 1990 && year <= 3000 ? year : undefined;
}

function dateOf(timestamp) {
  const n = Number(timestamp) || 0;
  if (n <= 0) return '';
  const d = new Date(n * 1000);
  const month = d.getMonth() + 1;
  const day = d.getDate();
  return `${d.getFullYear()}-${month < 10 ? '0' : ''}${month}-${day < 10 ? '0' : ''}${day}`;
}

function bvidFromUri(value) {
  const m = /BV[0-9A-Za-z]{10}/.exec(String(value || ''));
  return m ? m[0] : '';
}

function parseVideoId(itemId) {
  const parts = String(itemId || '').split(':');
  const bvid = bvidFromUri(parts[1] || '');
  const page = parts[2] ? Math.max(1, parseInt(parts[2], 10) || 1) : 1;
  return { bvid, page };
}

function deviceCodecs(ctx) {
  const raw = Array.isArray(ctx.device && ctx.device.codecs) ? ctx.device.codecs : [];
  const set = new Set(raw.map((c) => String(c).toLowerCase()));
  const out = [];
  if (set.has('avc') || set.has('h264')) out.push('avc');
  if (set.has('hevc') || set.has('h265')) out.push('hevc');
  if (set.has('av1')) out.push('av1');
  return out.length > 0 ? out : ['avc'];
}

function codecNameOf(track) {
  const id = Number(track && track.codecid);
  if (id === 12) return 'hevc';
  if (id === 13) return 'av1';
  if (id === 7) return 'avc';
  const codecs = String((track && track.codecs) || '').toLowerCase();
  if (codecs.indexOf('hev') === 0 || codecs.indexOf('hvc') === 0) return 'hevc';
  if (codecs.indexOf('av01') === 0) return 'av1';
  return 'avc';
}

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

function mapApiCode(ctx, code, message, opts = {}) {
  if (code === 0) return;
  const detail = String(message || '');
  if (code === -101) {
    if (opts.anonymousOk) return;
    throw new ctx.Error('NeedsAuth', ctx.t('err_needs_auth'));
  }
  if (code === -404 || code === 62002 || code === 62004) {
    throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  }
  if (code === -403) throw new ctx.Error('Forbidden', ctx.t('err_forbidden'));
  if (code === -10403) throw new ctx.Error('Forbidden', ctx.t('err_vip'));
  if (code === 87007 || code === 87008) throw new ctx.Error('Forbidden', ctx.t('err_charge'));
  if (code === -352 || code === -412) {
    throw new ctx.Error('RateLimited', ctx.t('err_risk_control'), { retryAfterSec: 30 });
  }
  throw new ctx.Error(
    'Internal',
    `${ctx.t('err_unexpected')}（${code}${detail ? ` ${detail}` : ''}）`,
  );
}

/* ------------------------------------------------------------------ */
/* session + network                                                   */
/* ------------------------------------------------------------------ */

async function getSession(ctx) {
  const session = await ctx.storage.get('session');
  if (!session || !session.sessdata) return null;
  return session;
}

async function requireSession(ctx) {
  const session = await getSession(ctx);
  if (!session) throw new ctx.Error('NeedsAuth', ctx.t('err_needs_auth'));
  return session;
}

function sessionCookie(session) {
  const parts = [`SESSDATA=${session.sessdata}`];
  if (session.biliJct) parts.push(`bili_jct=${session.biliJct}`);
  if (session.mid) parts.push(`DedeUserID=${session.mid}`);
  return parts.join('; ');
}

async function requestJson(ctx, url, opts = {}) {
  const headers = {
    'User-Agent': UA,
    Referer: opts.referer || REFERER,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };
  if (opts.contentType) headers['Content-Type'] = opts.contentType;
  if (opts.headers) {
    for (const key of Object.keys(opts.headers)) headers[key] = opts.headers[key];
  }
  if (opts.auth) {
    const session = opts.requireAuth ? await requireSession(ctx) : await getSession(ctx);
    if (session) headers.Cookie = sessionCookie(session);
  }

  let resp;
  try {
    resp = await ctx.fetch(url, {
      method: opts.method || 'GET',
      headers,
      body: opts.body,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    ctx.log.warn(
      `bilibili request failed (${opts.method || 'GET'} ${pathOf(url)}): ${err.message || err}`,
    );
    throw new ctx.Error('Unavailable', ctx.t('err_network'));
  }

  if (resp.status === 412) {
    throw new ctx.Error('RateLimited', ctx.t('err_risk_control'), { retryAfterSec: 60 });
  }
  if (resp.status === 429) {
    const retry = parseInt(resp.headers['retry-after'] || '30', 10);
    throw new ctx.Error('RateLimited', ctx.t('err_rate_limited'), {
      retryAfterSec: Number.isFinite(retry) ? retry : 30,
    });
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new ctx.Error('Forbidden', ctx.t('err_forbidden'));
  }
  if (resp.status === 404) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  if (resp.status >= 500) throw new ctx.Error('Unavailable', ctx.t('err_network'));
  if (resp.status < 200 || resp.status >= 300) {
    throw new ctx.Error('Internal', `${ctx.t('err_unexpected')}（HTTP ${resp.status}）`);
  }

  const text = resp.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ctx.Error('Unavailable', ctx.t('err_unexpected'));
  }
}

/* ------------------------------------------------------------------ */
/* WBI signing                                                         */
/* ------------------------------------------------------------------ */

function fileNameKey(url) {
  const s = String(url || '');
  const name = s.slice(s.lastIndexOf('/') + 1);
  const dot = name.indexOf('.');
  return dot >= 0 ? name.slice(0, dot) : name;
}

async function getWbiMixin(ctx) {
  if (wbiKey && Date.now() - wbiKey.at < 30 * 60 * 1000) return wbiKey.mixin;
  const j = await requestJson(ctx, `${API}/x/web-interface/nav`, { auth: true });
  const img = j && j.data && j.data.wbi_img ? j.data.wbi_img.img_url : '';
  const sub = j && j.data && j.data.wbi_img ? j.data.wbi_img.sub_url : '';
  const orig = fileNameKey(img) + fileNameKey(sub);
  if (orig.length < 64) throw new ctx.Error('Unavailable', ctx.t('err_unexpected'));
  const mixin = MIXIN_KEY_ENC_TAB.map((i) => orig.charAt(i)).join('').slice(0, 32);
  wbiKey = { mixin, at: Date.now() };
  return mixin;
}

function signedUrl(ctx, mixin, path, params) {
  const all = {};
  for (const key of Object.keys(params || {})) all[key] = params[key];
  all.wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(all)
    .sort()
    .map((key) => {
      const value = String(all[key] == null ? '' : all[key]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
    })
    .join('&');
  const wRid = ctx.crypto.md5(`${query}${mixin}`);
  return `${path}?${query}&w_rid=${wRid}`;
}

/* ------------------------------------------------------------------ */
/* item mapping                                                        */
/* ------------------------------------------------------------------ */

function mapArchiveItem(ctx, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid =
    String(raw.bvid || '') ||
    bvidFromUri(raw.uri) ||
    bvidFromUri(raw.short_link_v2) ||
    bvidFromUri(raw.arcurl);
  if (!bvid) return null;

  const item = {
    id: `v:${bvid}`,
    kind: 'video',
    title: cleanText(raw.title || raw.name || bvid) || bvid,
  };

  const owner = raw.owner && raw.owner.name ? raw.owner.name : raw.author || (raw.upper && raw.upper.name) || '';
  const tname = raw.tname || raw.typename || '';
  const seconds = typeof raw.duration === 'number' ? raw.duration : 0;
  const sub = [];
  if (owner) sub.push(cleanText(owner));
  if (tname) sub.push(cleanText(tname));
  if (sub.length === 0 && typeof raw.duration === 'string') sub.push(cleanText(raw.duration));
  if (sub.length > 0) item.subtitle = sub.join(' · ');

  const pic = raw.pic || raw.cover || raw.first_frame || '';
  if (pic) {
    item.thumb = image(pic);
    item.backdrop = image(pic);
    item.poster = image(pic);
  }
  const overview = raw.desc || raw.description || '';
  if (overview) item.overview = cleanText(overview).slice(0, 800);
  const published = raw.pubdate || raw.pubtime || raw.ctime;
  const year = yearOf(published);
  if (year) item.year = year;

  const durationMs =
    seconds > 0 ? Math.round(seconds * 1000) : parseDurationText(raw.duration);
  if (durationMs > 0) item.durationMs = durationMs;

  const badges = [];
  if (Number(raw.videos) > 1) badges.push('分P');
  if (raw.is_pay || raw.badgepay || (raw.rights && raw.rights.pay)) badges.push('会员');
  if (badges.length > 0) item.badges = badges;
  return item;
}

function mapVideoDetail(ctx, view) {
  const item = {
    id: `v:${view.bvid}`,
    kind: 'video',
    title: view.title,
  };
  const sub = [view.owner, view.tname].filter(Boolean);
  if (sub.length > 0) item.subtitle = sub.join(' · ');
  if (view.pic) {
    item.thumb = image(view.pic);
    item.backdrop = image(view.pic);
    item.poster = image(view.pic);
  }
  if (view.desc) item.overview = view.desc;
  const year = yearOf(view.pubdate);
  if (year) item.year = year;
  const firstPage = view.pages.length > 0 ? view.pages[0] : null;
  item.durationMs = firstPage && firstPage.durationMs > 0 ? firstPage.durationMs : view.durationMs;

  const badges = [];
  if (view.pages.length > 1) badges.push('分P');
  if (view.seasonEpisodes.length > 0) badges.push('合集');
  if (badges.length > 0) item.badges = badges;

  if (view.pages.length > 1) {
    item.childCount = view.pages.length;
    item.episodes = uniqueById(view.pages.map((p) => ({
      id: `v:${view.bvid}:${p.page}`,
      kind: 'episode',
      title: p.part ? `P${p.page} · ${p.part}` : `P${p.page}`,
      subtitle: formatDuration(p.durationMs / 1000),
      thumb: image(view.pic),
      durationMs: p.durationMs || undefined,
      parentId: `v:${view.bvid}`,
      index: p.page,
    })));
  } else if (view.seasonEpisodes.length > 0) {
    item.childCount = view.seasonEpisodes.length;
    item.episodes = uniqueById(view.seasonEpisodes.map((e, i) => ({
      id: e.id,
      kind: 'episode',
      title: e.title,
      subtitle: formatDuration(e.durationMs / 1000),
      thumb: image(view.pic),
      durationMs: e.durationMs || undefined,
      parentId: `v:${view.bvid}`,
      index: i + 1,
    })));
  }

  if (view.owner) {
    const person = { name: view.owner, role: 'UP主' };
    if (view.ownerFace) person.image = image(view.ownerFace);
    item.people = [person];
  }
  if (view.tname) item.genres = [view.tname];
  const extra = [
    { label: '播放', value: formatCount(view.stat.view) },
    { label: '弹幕', value: formatCount(view.stat.danmaku) },
  ];
  if (view.tname) extra.push({ label: '分区', value: view.tname });
  if (view.pubdate) extra.push({ label: '发布', value: dateOf(view.pubdate) });
  item.extra = extra;
  return item;
}

function mapPgcSeasonSummary(s) {
  const item = {
    id: `sg:${s.seasonId}`,
    kind: 'season',
    title: s.title || `季 ${s.seasonId}`,
  };
  if (s.indexShow) item.subtitle = s.indexShow;
  if (s.cover) item.poster = image(s.cover);
  if (s.badge) item.badges = [s.badge];
  return item;
}

function episodeTitle(ep) {
  const rawTitle = cleanText(ep.title || '');
  const label = /^\d+(\.\d+)?$/.test(rawTitle)
    ? `第 ${rawTitle} 话`
    : rawTitle || `第 ${ep.index} 话`;
  return ep.longTitle ? `${label} · ${ep.longTitle}` : label;
}

function mapPgcEpisode(season, ep) {
  const label = episodeTitle(ep);
  const item = {
    id: ep.id,
    kind: 'episode',
    title: label,
    thumb: image(ep.cover || season.cover),
    durationMs: ep.durationMs > 0 ? ep.durationMs : undefined,
    parentId: `sg:${season.seasonId}`,
    index: ep.index,
  };
  const subtitle = ep.durationMs > 0 ? formatDuration(ep.durationMs / 1000) : '';
  if (subtitle) item.subtitle = subtitle;
  if (ep.badge) item.badges = [ep.badge];
  return item;
}

function mapPgcDetail(season, kind, requestedId) {
  const item = {
    id: kind === 'series' ? `ss:${requestedId}` : `sg:${requestedId}`,
    kind,
    title: season.title,
  };
  if (season.seasonTitle && season.seasonTitle !== season.title) {
    item.subtitle = season.seasonTitle;
  }
  if (season.cover) item.poster = image(season.cover);
  if (season.bkgCover || season.cover) item.backdrop = image(season.bkgCover || season.cover);
  if (season.evaluate) item.overview = season.evaluate;
  if (season.rating > 0) item.rating = Math.min(10, Math.round(season.rating * 10) / 10);
  const year = season.year;
  if (year) item.year = year;
  if (season.styles.length > 0) item.genres = season.styles.slice(0, 8);

  if (kind === 'series') {
    item.childCount = season.seasons.length > 0 ? season.seasons.length : 1;
    item.seasons =
      season.seasons.length > 0
        ? uniqueById(season.seasons.map((s) => mapPgcSeasonSummary(s)))
        : [
            {
              id: `sg:${season.seasonId}`,
              kind: 'season',
              title: season.seasonTitle || season.title,
              poster: image(season.cover),
            },
          ];
  } else {
    item.childCount = season.episodes.length;
    item.episodes = uniqueById(season.episodes.map((ep) => mapPgcEpisode(season, ep)));
  }

  const extra = [];
  if (season.areas.length > 0) extra.push({ label: '地区', value: season.areas.slice(0, 3).join(' / ') });
  if (season.isFinish !== null) extra.push({ label: '状态', value: season.isFinish ? '已完结' : '连载中' });
  if (season.newEp) extra.push({ label: '更新', value: season.newEp });
  if (season.followText) extra.push({ label: '追番', value: season.followText });
  else if (season.favorites > 0) extra.push({ label: '追番', value: formatCount(season.favorites) });
  if (extra.length > 0) item.extra = extra;
  return item;
}

/* ------------------------------------------------------------------ */
/* API readers                                                         */
/* ------------------------------------------------------------------ */

async function fetchView(ctx, bvid) {
  const key = `view:${bvid}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const d = j.data || {};

  const pages = (Array.isArray(d.pages) ? d.pages : []).map((p) => ({
    page: Number(p.page) || 1,
    cid: Number(p.cid),
    durationMs: Math.round(Number(p.duration || 0) * 1000),
    part: cleanText(p.part || ''),
  }));

  const seasonEpisodes = [];
  const season = d.ugc_season;
  if (season && Array.isArray(season.sections)) {
    for (const section of season.sections) {
      for (const ep of section.episodes || []) {
        const arc = ep.arc || {};
        const epBvid = String(ep.bvid || arc.bvid || '');
        const cid = Number(ep.cid || (ep.page && ep.page.cid));
        if (!epBvid || !cid) continue;
        seasonEpisodes.push({
          id: `v:${epBvid}`,
          bvid: epBvid,
          cid,
          title: cleanText(ep.title || arc.title || (ep.page && ep.page.part) || epBvid),
          durationMs: Math.round(
            Number(arc.duration || (ep.page && ep.page.duration) || 0) * 1000,
          ),
        });
      }
    }
  }

  const view = {
    aid: Number(d.aid),
    bvid: String(d.bvid || bvid),
    cid: Number(d.cid),
    title: cleanText(d.title || bvid) || bvid,
    durationMs: Math.round(Number(d.duration || 0) * 1000),
    owner: cleanText((d.owner && d.owner.name) || ''),
    ownerFace: (d.owner && d.owner.face) || '',
    tname: cleanText(d.tname || ''),
    pubdate: Number(d.pubdate || 0),
    desc: cleanText(d.desc || ''),
    pic: d.pic || '',
    stat: {
      view: Number((d.stat && d.stat.view) || 0),
      danmaku: Number((d.stat && d.stat.danmaku) || 0),
      like: Number((d.stat && d.stat.like) || 0),
    },
    pages,
    seasonEpisodes,
  };
  cacheSet(key, view);
  return view;
}

function compactSeason(result) {
  const seasons = (Array.isArray(result.seasons) ? result.seasons : []).map((s) => ({
    seasonId: Number(s.season_id),
    title: cleanText(s.season_title || s.title || `季 ${s.season_id}`),
    cover: s.cover || s.horizontal_cover_169 || '',
    badge: cleanText(s.badge || ''),
    indexShow: cleanText((s.new_ep && s.new_ep.index_show) || ''),
  }));

  const episodes = (Array.isArray(result.episodes) ? result.episodes : []).map((e, i) => ({
    id: `ep:${Number(e.ep_id || e.id)}`,
    epId: Number(e.ep_id || e.id),
    aid: Number(e.aid),
    bvid: String(e.bvid || ''),
    cid: Number(e.cid),
    title: cleanText(e.title || ''),
    longTitle: cleanText(e.long_title || ''),
    cover: e.cover || result.cover || '',
    durationMs: Math.round(Number(e.duration || 0)),
    badge: cleanText(e.badge || ''),
    index: i + 1,
  }));

  const publish = result.publish || {};
  const pubTime = String(publish.pub_time || '');
  let year;
  if (/^\d{4}/.test(pubTime)) year = Number(pubTime.slice(0, 4));
  if (year && (year < 1990 || year > 3000)) year = undefined;

  const areas = (Array.isArray(result.areas) ? result.areas : [])
    .map((a) => cleanText(a.name || ''))
    .filter(Boolean);
  const styles = (Array.isArray(result.styles) ? result.styles : [])
    .map((s) => cleanText(s))
    .filter(Boolean);

  return {
    seasonId: Number(result.season_id),
    title: cleanText(result.title || result.season_title || '') || '未命名番剧',
    seasonTitle: cleanText(result.season_title || ''),
    cover: result.cover || '',
    bkgCover: result.bkg_cover || '',
    evaluate: cleanText(result.evaluate || ''),
    rating: Number((result.rating && result.rating.score) || 0),
    styles,
    areas,
    year,
    isFinish: publish.is_finish === undefined ? null : Number(publish.is_finish) === 1,
    newEp: cleanText((result.new_ep && result.new_ep.index_show) || ''),
    followText: cleanText((result.stat && result.stat.follow_text) || ''),
    favorites: Number((result.stat && result.stat.favorites) || 0),
    seasons,
    episodes,
  };
}

async function fetchSeasonById(ctx, seasonId) {
  const key = `season:${seasonId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await requestJson(
    ctx,
    `${API}/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`,
    { referer: `https://www.bilibili.com/bangumi/play/ss${seasonId}` },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  if (!j.result) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  const season = compactSeason(j.result);
  cacheSet(key, season);
  cacheSet(`season:by:${season.seasonId}`, season);
  return season;
}

async function fetchSeasonByEp(ctx, epId) {
  const key = `season:ep:${epId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await requestJson(
    ctx,
    `${API}/pgc/view/web/season?ep_id=${encodeURIComponent(epId)}`,
    { referer: `https://www.bilibili.com/bangumi/play/ep${epId}` },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  if (!j.result) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  const season = compactSeason(j.result);
  cacheSet(key, season);
  cacheSet(`season:${season.seasonId}`, season);
  return season;
}

/* ------------------------------------------------------------------ */
/* playback metadata                                                   */
/* ------------------------------------------------------------------ */

function nextVideoId(view, page) {
  const index = view.pages.findIndex((p) => p.page === page);
  if (index >= 0 && index + 1 < view.pages.length) {
    return `v:${view.bvid}:${view.pages[index + 1].page}`;
  }
  const sIndex = view.seasonEpisodes.findIndex((e) => e.bvid === view.bvid);
  if (sIndex >= 0 && sIndex + 1 < view.seasonEpisodes.length) {
    return view.seasonEpisodes[sIndex + 1].id;
  }
  return undefined;
}

async function metaForVideo(ctx, itemId) {
  const { bvid, page } = parseVideoId(itemId);
  if (!bvid) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  const view = await fetchView(ctx, bvid);
  const pages =
    view.pages.length > 0
      ? view.pages
      : [{ page: 1, cid: view.cid, durationMs: view.durationMs, part: '' }];
  const selected = pages.find((p) => p.page === page) || pages[0];
  if (!selected || !selected.cid) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  return {
    kind: 'ugc',
    aid: view.aid,
    bvid,
    cid: selected.cid,
    page: selected.page,
    durationMs: selected.durationMs || view.durationMs,
    title: selected.page > 1 ? `${view.title} · P${selected.page}` : view.title,
    next: nextVideoId(view, selected.page),
    session: `v-${bvid}-${selected.cid}`,
  };
}

function metaForEpisodeInSeason(season, index) {
  const ep = season.episodes[index];
  if (!ep || !ep.cid) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  return {
    kind: 'pgc',
    aid: ep.aid,
    bvid: ep.bvid,
    cid: ep.cid,
    epId: ep.epId,
    seasonId: season.seasonId,
    durationMs: ep.durationMs,
    title: episodeTitle(ep),
    next:
      index + 1 < season.episodes.length ? season.episodes[index + 1].id : undefined,
    session: `ep-${ep.epId}-${ep.cid}`,
  };
}

async function metaForEpisode(ctx, itemId) {
  const epId = Number(String(itemId).slice(3));
  if (!Number.isFinite(epId) || epId <= 0) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  const season = await fetchSeasonByEp(ctx, epId);
  const index = season.episodes.findIndex((e) => e.epId === epId);
  if (index < 0) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  return metaForEpisodeInSeason(season, index);
}

async function metaForSeason(ctx, itemId) {
  const seasonId = Number(String(itemId).slice(3));
  if (!Number.isFinite(seasonId) || seasonId <= 0) {
    throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  }
  const season = await fetchSeasonById(ctx, seasonId);
  if (season.episodes.length === 0) {
    throw new ctx.Error('Unsupported', ctx.t('err_no_stream'));
  }
  return metaForEpisodeInSeason(season, 0);
}

async function playbackMeta(ctx, itemId) {
  const key = `meta:${itemId}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  let meta;
  if (String(itemId).startsWith('v:')) meta = await metaForVideo(ctx, itemId);
  else if (String(itemId).startsWith('ep:')) meta = await metaForEpisode(ctx, itemId);
  else if (String(itemId).startsWith('sg:') || String(itemId).startsWith('ss:')) {
    meta = await metaForSeason(ctx, itemId);
  }
  if (!meta) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  cacheSet(key, meta);
  return meta;
}

/* ------------------------------------------------------------------ */
/* shelves / pages                                                     */
/* ------------------------------------------------------------------ */

function regionItems() {
  return REGIONS.map((r) => ({
    id: `region:${r.rid}`,
    kind: 'folder',
    title: r.title,
    subtitle: '分区',
  }));
}

async function historyShelf(ctx) {
  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/history/cursor?max=0&view_at=0&ps=${PAGE_SIZE}&business=archive`,
    { auth: true, requireAuth: true },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.list) ? j.data.list : [];
  const items = [];
  for (const raw of list) {
    const item = mapHistoryItem(raw);
    if (item) items.push(item);
  }
  return items;
}

function mapHistoryItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const h = raw.history || {};

  if (h.business === 'pgc' || h.business === 'pgv') {
    const epId = Number(h.epid || 0);
    if (!epId) return null;
    const item = {
      id: `ep:${epId}`,
      kind: 'episode',
      title: cleanText(raw.title || raw.long_title || `剧集 ${epId}`),
    };
    if (raw.long_title && raw.long_title !== raw.title) {
      item.subtitle = cleanText(raw.long_title);
    }
    const cover = raw.cover || (Array.isArray(raw.covers) ? raw.covers[0] : '');
    if (cover) {
      item.thumb = image(cover);
      item.backdrop = image(cover);
      item.poster = image(cover);
    }
    const durationMs = Math.round(Number(raw.duration || 0) * 1000);
    const progressMs = Math.round(Number(raw.progress || 0) * 1000);
    if (durationMs > 0) item.durationMs = durationMs;
    if (progressMs > 0) item.progressMs = progressMs;
    if (durationMs > 0 && progressMs >= durationMs - 5000) item.played = true;
    return item;
  }

  if (h.business && h.business !== 'archive') return null;
  const bvid = String(h.bvid || raw.bvid || '');
  if (!bvid) return null;
  const page = Number(h.page) || 1;
  const item = {
    id: page > 1 ? `v:${bvid}:${page}` : `v:${bvid}`,
    kind: 'video',
    title: cleanText(raw.title || raw.long_title || bvid) || bvid,
  };
  const sub = [];
  if (raw.author_name) sub.push(cleanText(raw.author_name));
  if (page > 1) sub.push(`P${page}`);
  if (sub.length > 0) item.subtitle = sub.join(' · ');
  const cover = raw.cover || (Array.isArray(raw.covers) ? raw.covers[0] : '');
  if (cover) {
    item.thumb = image(cover);
    item.backdrop = image(cover);
    item.poster = image(cover);
  }
  const durationMs = Math.round(Number(raw.duration || 0) * 1000);
  const progressMs = Math.round(Number(raw.progress || 0) * 1000);
  if (durationMs > 0) item.durationMs = durationMs;
  if (progressMs > 0) item.progressMs = progressMs;
  if (durationMs > 0 && progressMs >= durationMs - 5000) item.played = true;
  return item;
}

// Slices an already-fetched list by an offset cursor. Used for endpoints that
// return their whole result set in one response (rankings), so the wall's
// infinite scroll can keep appending pages out of a cached list.
function slicePage(items, cursor) {
  const offset = cursor ? Math.max(0, parseInt(cursor, 10) || 0) : 0;
  const slice = items.slice(offset, offset + PAGE_SIZE);
  const nextOffset = offset + slice.length;
  return { slice, next: nextOffset < items.length ? String(nextOffset) : null };
}

// The recommendation feed pages by `fresh_idx`: each index returns a fresh batch
// of ~20 items (verified against the live API), which maps directly onto an
// opaque cursor for the wall's endless scroll.
async function recommendPage(ctx, cursor) {
  const freshIdx = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/index/top/feed/rcmd?ps=${PAGE_SIZE}&fresh_idx=${freshIdx}&fresh_type=3`,
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.item) ? j.data.item : [];
  const items = [];
  for (const raw of list) {
    if (raw && raw.goto && raw.goto !== 'av') continue;
    const item = mapArchiveItem(ctx, raw);
    if (item) items.push(item);
  }
  const hasNext = items.length > 0 && freshIdx < 50 && list.length >= PAGE_SIZE;
  return { items: uniqueById(items), next: hasNext ? String(freshIdx + 1) : null };
}

async function popularPage(ctx, cursor) {
  const pn = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/popular?ps=${PAGE_SIZE}&pn=${pn}`,
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.list) ? j.data.list : [];
  const items = [];
  for (const raw of list) {
    const item = mapArchiveItem(ctx, raw);
    if (item) items.push(item);
  }
  const noMore = Boolean(j.data && j.data.no_more);
  return {
    items: uniqueById(items),
    next: noMore || list.length < PAGE_SIZE ? null : String(pn + 1),
  };
}

// ranking/v2 returns the whole chart (~100 entries) with no paging parameter.
async function rankingList(ctx) {
  const key = 'ranking:all';
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await requestJson(ctx, `${API}/x/web-interface/ranking/v2?rid=0&type=all`);
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.list) ? j.data.list : [];
  cacheSet(key, list, FAV_TTL_MS);
  return list;
}

async function rankingPage(ctx, cursor) {
  const list = await rankingList(ctx);
  const { slice, next } = slicePage(list, cursor);
  const items = [];
  for (const raw of slice) {
    const item = mapArchiveItem(ctx, raw);
    if (item) items.push(item);
  }
  return { items: uniqueById(items), next };
}

// pgc/web/rank/list also returns the whole chart (番剧 ~100, 影视 ~48 entries).
async function pgcRankList(ctx, seasonType) {
  const key = `pgcrank:${seasonType}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const j = await requestJson(
    ctx,
    `${API}/pgc/web/rank/list?day=3&season_type=${seasonType}`,
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.result && j.result.list) ? j.result.list : [];
  cacheSet(key, list, FAV_TTL_MS);
  return list;
}

async function pgcRankPage(ctx, seasonType, cursor) {
  const list = await pgcRankList(ctx, seasonType);
  const { slice, next } = slicePage(list, cursor);
  const items = [];
  for (const raw of slice) {
    const seasonId = Number(raw && raw.season_id);
    if (!seasonId) continue;
    const item = {
      id: `ss:${seasonId}`,
      kind: 'series',
      title: cleanText(raw.title) || `番剧 ${seasonId}`,
    };
    const sub = [];
    if (raw.badge) sub.push(cleanText(raw.badge));
    if (raw.new_ep && raw.new_ep.index_show) sub.push(cleanText(raw.new_ep.index_show));
    if (sub.length > 0) item.subtitle = sub.join(' · ');
    if (raw.cover) item.poster = image(raw.cover);
    const score = parseFloat(String(raw.rating || '').replace(/[^\d.]/g, ''));
    if (Number.isFinite(score) && score > 0) item.rating = score;
    if (raw.badge) item.badges = [cleanText(raw.badge)];
    items.push(item);
  }
  return { items: uniqueById(items), next };
}

async function regionPage(ctx, ridText, cursor) {
  const rid = parseInt(ridText, 10);
  if (!Number.isFinite(rid) || rid <= 0) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  const pn = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/newlist?rid=${rid}&type=0&pn=${pn}&ps=${PAGE_SIZE}`,
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.archives) ? j.data.archives : [];
  const items = [];
  for (const raw of list) {
    const item = mapArchiveItem(ctx, raw);
    if (item) items.push(item);
  }
  return {
    items: uniqueById(items),
    next: list.length < PAGE_SIZE ? null : String(pn + 1),
  };
}

async function historyPage(ctx, cursor) {
  let max = 0;
  let viewAt = 0;
  if (cursor) {
    const parts = String(cursor).split(':');
    max = Number(parts[0]) || 0;
    viewAt = Number(parts[1]) || 0;
  }
  const j = await requestJson(
    ctx,
    `${API}/x/web-interface/history/cursor?max=${max}&view_at=${viewAt}&ps=${PAGE_SIZE}&business=archive`,
    { auth: true, requireAuth: true },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const list = Array.isArray(j.data && j.data.list) ? j.data.list : [];
  const items = [];
  for (const raw of list) {
    const item = mapHistoryItem(raw);
    if (item) items.push(item);
  }
  let next = null;
  if (list.length > 0 && j.data && j.data.cursor) {
    const candidate = `${j.data.cursor.max}:${j.data.cursor.view_at}`;
    if (candidate !== cursor) next = candidate;
  }
  return { items: uniqueById(items), next };
}

async function favFolderList(ctx) {
  const key = 'fav:folders';
  const hit = cacheGet(key);
  if (hit) return hit;
  const session = await requireSession(ctx);
  if (!session.mid) throw new ctx.Error('NeedsAuth', ctx.t('err_needs_auth'));
  const j = await requestJson(
    ctx,
    `${API}/x/v3/fav/folder/created/list-all?up_mid=${encodeURIComponent(session.mid)}`,
    { auth: true, requireAuth: true },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const folders = (Array.isArray(j.data && j.data.list) ? j.data.list : []).map((f) => ({
    id: String(f.id),
    title: cleanText(f.name || '收藏夹'),
    count: Number(f.media_count) || 0,
  }));
  cacheSet(key, folders, FAV_TTL_MS);
  return folders;
}

async function favFoldersPage(ctx, cursor) {
  const folders = await favFolderList(ctx);
  const mapped = folders.map((f) => ({
    id: `fav:${f.id}`,
    kind: 'folder',
    title: f.title,
    subtitle: `${f.count} 个视频`,
    childCount: f.count,
  }));
  const { slice, next } = slicePage(mapped, cursor);
  return { items: uniqueById(slice), next };
}

function mapFavMedia(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bvid = String(raw.bvid || '');
  if (!bvid) return null;
  const item = {
    id: `v:${bvid}`,
    kind: 'video',
    title: cleanText(raw.title || bvid) || bvid,
  };
  const sub = [];
  if (raw.upper && raw.upper.name) sub.push(cleanText(raw.upper.name));
  if (raw.duration) sub.push(formatDuration(raw.duration));
  if (sub.length > 0) item.subtitle = sub.join(' · ');
  if (raw.cover) {
    item.thumb = image(raw.cover);
    item.backdrop = image(raw.cover);
    item.poster = image(raw.cover);
  }
  if (raw.intro) item.overview = cleanText(raw.intro).slice(0, 600);
  if (raw.duration) item.durationMs = Math.round(Number(raw.duration) * 1000);
  const year = yearOf(raw.pubtime);
  if (year) item.year = year;
  if (Number(raw.page) > 1) item.badges = ['分P'];
  return item;
}

async function favItemsPage(ctx, mediaId, cursor) {
  const pn = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
  const j = await requestJson(
    ctx,
    `${API}/x/v3/fav/resource/list?media_id=${encodeURIComponent(mediaId)}&pn=${pn}&ps=${PAGE_SIZE}&platform=web`,
    { auth: true, requireAuth: true },
  );
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  const medias = Array.isArray(j.data && j.data.medias) ? j.data.medias : [];
  const items = [];
  for (const raw of medias) {
    const item = mapFavMedia(raw);
    if (item) items.push(item);
  }
  return {
    items: uniqueById(items),
    next: j.data && j.data.has_more ? String(pn + 1) : null,
  };
}

/* ------------------------------------------------------------------ */
/* playback payloads                                                   */
/* ------------------------------------------------------------------ */

function pickQn(ctx, quality) {
  const raw = quality !== null && quality !== undefined && String(quality).trim() !== ''
    ? String(quality).trim()
    : String(ctx.config.quality || 'auto');
  if (/^\d+$/.test(raw)) return Number(raw);
  return QN_BY_CONFIG[raw] || 80;
}

async function fetchUgcPlayurl(ctx, meta, quality) {
  const mixin = await getWbiMixin(ctx);
  const url = signedUrl(ctx, mixin, `${API}/x/player/wbi/playurl`, {
    bvid: meta.bvid,
    cid: meta.cid,
    fnval: 4048,
    fnver: 0,
    fourk: 1,
    qn: pickQn(ctx, quality),
  });
  const j = await requestJson(ctx, url, { auth: true });
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  return j.data || {};
}

async function fetchPgcPlayurl(ctx, meta, quality) {
  const url =
    `${API}/pgc/player/web/playurl?ep_id=${encodeURIComponent(meta.epId)}` +
    `&cid=${encodeURIComponent(meta.cid)}&avid=${encodeURIComponent(meta.aid)}` +
    `&module=bangumi&fnval=4048&fnver=0&fourk=1` +
    `&qn=${pickQn(ctx, quality)}`;
  const j = await requestJson(ctx, url, {
    auth: true,
    referer: `https://www.bilibili.com/bangumi/play/ep${meta.epId}`,
  });
  if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  return j.result || j.data || {};
}

function buildQualities(ctx, data, meta) {
  const dashVideos = Array.isArray(data.dash && data.dash.video) ? data.dash.video : [];
  const available = new Set(dashVideos.map((v) => String(v.id)));
  const formats = Array.isArray(data.support_formats) ? data.support_formats : [];
  // Bilibili may report a nominal `quality` that the account cannot actually
  // receive (e.g. 720P in `quality` while DASH only contains 480P). Trust the
  // tracks that were really returned and never mark a locked quality selected.
  let selected = data.quality === undefined || data.quality === null ? '' : String(data.quality);
  if (available.size > 0 && !available.has(selected)) {
    selected = '';
    const ranked = Array.from(available).sort((a, b) => Number(b) - Number(a));
    if (ranked.length > 0) selected = ranked[0];
  }
  const list = [];
  for (const f of formats) {
    const id = String(f.quality);
    if (!id || id === 'undefined' || id === 'null') continue;
    const option = {
      id,
      label: cleanText(f.new_description || f.display_desc || QUALITY_LABELS[id] || `清晰度 ${id}`),
    };
    if (id === selected) option.selected = true;
    if (available.size > 0 && !available.has(id)) {
      option.locked = f.need_vip ? ctx.t('lock_vip') : ctx.t('lock_login');
    }
    list.push(option);
  }
  if (list.length === 0) {
    for (const id of available) {
      list.push({
        id,
        label: QUALITY_LABELS[id] || id,
        selected: id === selected,
      });
    }
  }
  if (list.length === 0 && meta) {
    list.push({ id: 'auto', label: '自动', selected: true });
  }
  return list;
}

async function buildSubtitles(ctx, meta) {
  const session = await getSession(ctx);
  if (!session || !meta.aid || !meta.cid) return [];
  try {
    const mixin = await getWbiMixin(ctx);
    const url = signedUrl(ctx, mixin, `${API}/x/player/wbi/v2`, {
      aid: meta.aid,
      cid: meta.cid,
    });
    const j = await requestJson(ctx, url, { auth: true });
    if (j.code !== 0) return [];
    const list =
      j.data && j.data.subtitle && Array.isArray(j.data.subtitle.subtitles)
        ? j.data.subtitle.subtitles
        : [];
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i] || {};
      const raw = s.subtitle_url || s.subtitle_url_v2 || '';
      const url2 = httpsUrl(raw);
      if (!url2) continue;
      const entry = {
        id: String(s.id || s.id_str || `sub-${i}`),
        label: cleanText(s.lan_doc || s.lan || '字幕') || '字幕',
        url: url2,
        format: 'json',
        headers: { Referer: REFERER, 'User-Agent': UA },
      };
      if (s.lan) entry.lang = String(s.lan);
      if (i === 0) entry.default = true;
      out.push(entry);
    }
    return out;
  } catch (err) {
    ctx.log.debug(`bilibili subtitles unavailable: ${err.message || err}`);
    return [];
  }
}

function buildPlayback(ctx, data, meta, quality) {
  if (!data || typeof data !== 'object') {
    throw new ctx.Error('Unavailable', ctx.t('err_no_stream'));
  }
  if (data.is_drm === true || data.is_drm === 1) {
    throw new ctx.Error('Unsupported', ctx.t('err_drm'));
  }
  if (data.is_preview === true || data.is_preview === 1) {
    throw new ctx.Error('Forbidden', ctx.t('err_preview'));
  }

  const streamHeaders = { Referer: REFERER, 'User-Agent': UA };
  const dash = data.dash;
  const dashDurationMs = dash ? Math.round(Number(dash.duration || 0) * 1000) : 0;
  const durationMs = Number(data.timelength) || dashDurationMs || meta.durationMs || 0;

  if (dash && Array.isArray(dash.video) && dash.video.length > 0) {
    const codecs = deviceCodecs(ctx);
    const videos = [];
    for (const v of dash.video) {
      const codec = codecNameOf(v);
      if (codecs.indexOf(codec) < 0) continue;
      const url = httpsUrl(v.baseUrl || v.base_url);
      if (!url) continue;
      const seg = v.SegmentBase || v.segment_base || {};
      const track = {
        id: `v-${v.id}-${codec}`,
        url,
        mime: v.mimeType || v.mime_type || 'video/mp4',
        codecs: String(v.codecs || ''),
        bandwidth: Number(v.bandwidth) || 0,
        quality: String(v.id),
      };
      const backups = (v.backupUrl || v.backup_url || []).map(httpsUrl).filter(Boolean);
      if (backups.length > 0) track.backupUrls = backups;
      if (Number(v.width) > 0) track.width = Math.round(Number(v.width));
      if (Number(v.height) > 0) track.height = Math.round(Number(v.height));
      const frameRate = Number(v.frameRate);
      if (frameRate > 0) track.frameRate = Math.round(frameRate * 1000) / 1000;
      if (seg.Initialization || seg.initialization) {
        track.initRange = String(seg.Initialization || seg.initialization);
      }
      if (seg.indexRange) track.indexRange = String(seg.indexRange);
      videos.push(track);
    }
    if (videos.length === 0) throw new ctx.Error('Unsupported', ctx.t('err_codec'));

    const audios = [];
    for (const a of dash.audio || []) {
      const url = httpsUrl(a.baseUrl || a.base_url);
      if (!url) continue;
      const seg = a.SegmentBase || a.segment_base || {};
      const track = {
        id: String(a.id),
        url,
        mime: a.mimeType || a.mime_type || 'audio/mp4',
        codecs: String(a.codecs || ''),
        bandwidth: Number(a.bandwidth) || 0,
      };
      const backups = (a.backupUrl || a.backup_url || []).map(httpsUrl).filter(Boolean);
      if (backups.length > 0) track.backupUrls = backups;
      if (seg.Initialization || seg.initialization) {
        track.initRange = String(seg.Initialization || seg.initialization);
      }
      if (seg.indexRange) track.indexRange = String(seg.indexRange);
      audios.push(track);
    }

    return {
      title: meta.title,
      durationMs: durationMs > 0 ? durationMs : 1,
      dash: { video: videos, audio: audios },
      headers: streamHeaders,
      qualities: buildQualities(ctx, data, meta),
      audios: audios.map((a) => ({
        id: a.id,
        label: AUDIO_LABELS[a.id] || `音轨 ${a.id}`,
        lang: 'zh',
      })),
      expiresAt: Date.now() + PLAY_URL_TTL_MS,
      next: meta.next,
      session: meta.session,
    };
  }

  const durl = Array.isArray(data.durl) ? data.durl : [];
  if (durl.length === 1) {
    const url = httpsUrl(durl[0].url);
    if (url) {
      return {
        title: meta.title,
        url,
        headers: streamHeaders,
        qualities: buildQualities(ctx, data, meta),
        expiresAt: Date.now() + PLAY_URL_TTL_MS,
        next: meta.next,
        session: meta.session,
      };
    }
  }
  throw new ctx.Error('Unsupported', ctx.t('err_no_stream'));
}

/* ------------------------------------------------------------------ */
/* login helpers                                                       */
/* ------------------------------------------------------------------ */

// The host renders QR codes with a byte-mode, ECC-L encoder limited to QR
// versions 1..6, i.e. 134 payload bytes (QrCodeMatrix.kt), and throws on longer
// input. Bilibili's login URL is ~145 bytes with its analytics parameters, so
// the payload is trimmed to what the confirm page actually needs:
// `qrcode_key` is the only functional parameter; `navhide`, `callback` and
// `from` only affect the H5 page chrome and analytics.
const QR_MAX_BYTES = 134;
const QR_BASE = 'https://account.bilibili.com/h5/account-h5/auth/scan-web';

function utf8ByteLength(text) {
  const s = String(text || '');
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function fitQrPayload(ctx, url, qrcodeKey) {
  const full = String(url || '');
  const candidates = [
    full,
    full.replace(/&from=[^&]*/i, ''),
    full.replace(/&from=[^&]*/i, '').replace(/&callback=[^&]*/i, ''),
    full
      .replace(/&from=[^&]*/i, '')
      .replace(/&callback=[^&]*/i, '')
      .replace(/&navhide=[^&]*/i, ''),
    `${QR_BASE}?qrcode_key=${encodeURIComponent(qrcodeKey)}`,
  ];
  for (const candidate of candidates) {
    if (candidate && utf8ByteLength(candidate) <= QR_MAX_BYTES) return candidate;
  }
  throw new ctx.Error('Unavailable', ctx.t('err_qr_too_long'));
}

// Keep tokens byte-for-byte as the server wrote them: SESSDATA is already
// cookie-encoded (%2C etc.) and must not be decoded before being sent back.
function parseUrlParams(url) {  const out = {};
  const s = String(url || '');
  const q = s.indexOf('?');
  if (q < 0) return out;
  const query = s.slice(q + 1).split('#')[0];
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    const value = eq >= 0 ? pair.slice(eq + 1) : '';
    if (key && !(key in out)) out[key] = value;
  }
  return out;
}

function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const piece = part.trim();
    if (!piece) continue;
    const eq = piece.indexOf('=');
    if (eq <= 0) continue;
    out[piece.slice(0, eq)] = piece.slice(eq + 1);
  }
  return out;
}

async function fetchProfile(ctx, session) {
  let j;
  try {
    j = await requestJson(ctx, `${API}/x/web-interface/nav`, { auth: true });
  } catch (err) {
    ctx.log.warn(`bilibili profile fetch failed: ${err.message || err}`);
    return { name: '哔哩哔哩用户' };
  }
  const data = (j && j.data) || {};
  if (!data.isLogin) throw new ctx.Error('AuthFailed', ctx.t('err_auth_failed'));
  const name = cleanText(data.uname || '哔哩哔哩用户') || '哔哩哔哩用户';
  const user = { name };
  if (data.face) user.avatar = image(data.face);
  const mid = Number(data.mid);
  if (Number.isFinite(mid) && mid > 0) session.mid = String(mid);
  return user;
}

/* ------------------------------------------------------------------ */
/* plugin entry                                                        */
/* ------------------------------------------------------------------ */

export default {
  async home(ctx) {
    const session = await getSession(ctx);
    const tasks = [];
    if (session) {
      tasks.push({
        id: 'bili-history',
        title: ctx.t('shelf_history'),
        style: 'continue',
        load: () => historyShelf(ctx),
      });
    }
    tasks.push({
      id: 'bili-recommend',
      title: ctx.t('shelf_recommend'),
      style: 'thumb',
      more: 'recommend',
      load: () => recommendPage(ctx, null).then((page) => page.items),
    });
    tasks.push({
      id: 'bili-popular',
      title: ctx.t('shelf_popular'),
      style: 'thumb',
      more: 'popular',
      load: () => popularPage(ctx, null).then((page) => page.items),
    });
    tasks.push({
      id: 'bili-ranking',
      title: ctx.t('shelf_ranking'),
      style: 'poster',
      more: 'ranking',
      load: () => rankingPage(ctx, null).then((page) => page.items),
    });
    tasks.push({
      id: 'bili-bangumi',
      title: ctx.t('shelf_bangumi'),
      style: 'poster',
      more: 'bangumi',
      load: () => pgcRankPage(ctx, 1, null).then((page) => page.items),
    });

    const settled = await Promise.allSettled(tasks.map((t) => t.load()));
    const shelves = [];
    let contentCount = 0;
    let firstError = null;
    for (let i = 0; i < settled.length; i++) {
      const result = settled[i];
      const task = tasks[i];
      if (result.status === 'fulfilled') {
        if (Array.isArray(result.value) && result.value.length > 0) {
          const shelf = { id: task.id, title: task.title, items: uniqueById(result.value) };
          if (task.style) shelf.style = task.style;
          if (task.more) shelf.more = task.more;
          shelves.push(shelf);
          contentCount++;
        }
      } else {
        if (result.reason && result.reason.code === 'NeedsAuth') throw result.reason;
        if (!firstError) firstError = result.reason;
        ctx.log.warn(
          `bilibili home shelf ${task.id} failed: ${(result.reason && result.reason.message) || result.reason}`,
        );
      }
    }

    shelves.push({
      id: 'bili-regions',
      title: ctx.t('shelf_regions'),
      style: 'category',
      items: uniqueById(regionItems()),
    });

    if (contentCount === 0 && firstError) throw firstError;
    return shelves;
  },

  async categories(ctx) {
    const session = await getSession(ctx);
    const list = [
      { id: 'recommend', title: ctx.t('shelf_recommend'), icon: 'collection' },
      { id: 'popular', title: ctx.t('cat_popular'), icon: 'video' },
      { id: 'ranking', title: ctx.t('cat_ranking'), icon: 'collection' },
      { id: 'bangumi', title: ctx.t('cat_bangumi'), icon: 'tv' },
      { id: 'movie', title: ctx.t('cat_movie'), icon: 'movie' },
    ];
    if (session) {
      list.push({ id: 'history', title: ctx.t('cat_history'), icon: 'collection' });
      list.push({ id: 'favs', title: ctx.t('cat_favs'), icon: 'folder' });
    }
    for (const region of REGIONS) {
      list.push({ id: `region:${region.rid}`, title: region.title, icon: 'folder' });
    }
    return list;
  },

  async browse(ctx, { categoryId = '', cursor = null, sort = null, filters = null } = {}) {
    const id = String(categoryId || '');
    if (!id) {
      return {
        items: uniqueById([
          { id: 'recommend', kind: 'folder', title: ctx.t('shelf_recommend') },
          { id: 'popular', kind: 'folder', title: ctx.t('cat_popular') },
          { id: 'ranking', kind: 'folder', title: ctx.t('cat_ranking') },
          { id: 'bangumi', kind: 'folder', title: ctx.t('cat_bangumi') },
          { id: 'movie', kind: 'folder', title: ctx.t('cat_movie') },
          ...regionItems(),
        ]),
        next: null,
      };
    }
    if (id === 'recommend') return recommendPage(ctx, cursor);
    if (id === 'popular') return popularPage(ctx, cursor);
    if (id === 'ranking') return rankingPage(ctx, cursor);
    if (id === 'bangumi') return pgcRankPage(ctx, 1, cursor);
    if (id === 'movie') return pgcRankPage(ctx, 2, cursor);
    if (id === 'history') return historyPage(ctx, cursor);
    if (id === 'favs') return favFoldersPage(ctx, cursor);
    if (id.indexOf('fav:') === 0) return favItemsPage(ctx, id.slice(4), cursor);
    if (id.indexOf('region:') === 0) return regionPage(ctx, id.slice(7), cursor);
    throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  },

  async detail(ctx, { itemId }) {
    const id = String(itemId || '');

    if (id.indexOf('v:') === 0) {
      const { bvid, page } = parseVideoId(id);
      if (!bvid) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
      const view = await fetchView(ctx, bvid);
      if (page > 1) {
        const p = view.pages.find((x) => x.page === page);
        if (!p) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
        const item = {
          id: `v:${bvid}:${p.page}`,
          kind: 'episode',
          title: p.part ? `${view.title} · P${p.page} ${p.part}` : `${view.title} · P${p.page}`,
          subtitle: formatDuration(p.durationMs / 1000),
          thumb: image(view.pic),
          durationMs: p.durationMs || undefined,
          parentId: `v:${bvid}`,
          index: p.page,
        };
        if (view.owner) item.people = [{ name: view.owner, role: 'UP主' }];
        return item;
      }

      const item = mapVideoDetail(ctx, view);
      try {
        const j = await requestJson(
          ctx,
          `${API}/x/web-interface/archive/related?bvid=${encodeURIComponent(bvid)}`,
        );
        if (j.code === 0 && Array.isArray(j.data)) {
          const related = [];
          for (const raw of j.data) {
            const r = mapArchiveItem(ctx, raw);
            if (r) related.push(r);
            if (related.length >= 8) break;
          }
          if (related.length > 0) item.related = uniqueById(related);
        }
      } catch (err) {
        ctx.log.debug(`bilibili related videos unavailable: ${err.message || err}`);
      }
      return item;
    }

    if (id.indexOf('ss:') === 0) {
      const seasonId = Number(id.slice(3));
      if (!Number.isFinite(seasonId) || seasonId <= 0) {
        throw new ctx.Error('NotFound', ctx.t('err_not_found'));
      }
      const season = await fetchSeasonById(ctx, seasonId);
      return mapPgcDetail(season, 'series', seasonId);
    }

    if (id.indexOf('sg:') === 0) {
      const seasonId = Number(id.slice(3));
      if (!Number.isFinite(seasonId) || seasonId <= 0) {
        throw new ctx.Error('NotFound', ctx.t('err_not_found'));
      }
      const season = await fetchSeasonById(ctx, seasonId);
      return mapPgcDetail(season, 'season', seasonId);
    }

    if (id.indexOf('ep:') === 0) {
      const epId = Number(id.slice(3));
      if (!Number.isFinite(epId) || epId <= 0) {
        throw new ctx.Error('NotFound', ctx.t('err_not_found'));
      }
      const season = await fetchSeasonByEp(ctx, epId);
      const ep = season.episodes.find((e) => e.epId === epId);
      if (!ep) throw new ctx.Error('NotFound', ctx.t('err_not_found'));
      return mapPgcEpisode(season, ep);
    }

    throw new ctx.Error('NotFound', ctx.t('err_not_found'));
  },

  async playback(ctx, { itemId, quality = null, audio = null }) {
    const meta = await playbackMeta(ctx, itemId);
    const data =
      meta.kind === 'ugc'
        ? await fetchUgcPlayurl(ctx, meta, quality)
        : await fetchPgcPlayurl(ctx, meta, quality);
    const result = buildPlayback(ctx, data, meta, quality);
    const subtitles = await buildSubtitles(ctx, meta);
    if (subtitles.length > 0) result.subtitles = subtitles;
    return result;
  },

  async search(ctx, { query = '', cursor = null, kind = null } = {}) {
    const keyword = String(query || '').trim();
    if (!keyword) return { items: [], next: null };
    const page = cursor ? Math.max(1, parseInt(cursor, 10) || 1) : 1;
    const mixin = await getWbiMixin(ctx);

    if (kind === 'series') {
      const url = signedUrl(ctx, mixin, `${API}/x/web-interface/wbi/search/type`, {
        search_type: 'media_bangumi',
        keyword,
        page,
        page_size: PAGE_SIZE,
      });
      const j = await requestJson(ctx, url, { referer: SEARCH_REFERER });
      if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
      const data = j.data || {};
      const list = Array.isArray(data.result) ? data.result : [];
      const items = [];
      for (const raw of list) {
        const seasonId = Number(raw.season_id || raw.pgc_season_id || 0);
        if (!seasonId) continue;
        const item = {
          id: `ss:${seasonId}`,
          kind: 'series',
          title: cleanText(raw.title) || `番剧 ${seasonId}`,
        };
        const sub = [];
        if (raw.season_type_name) sub.push(cleanText(raw.season_type_name));
        if (raw.index_show) sub.push(cleanText(raw.index_show));
        if (sub.length > 0) item.subtitle = sub.join(' · ');
        if (raw.cover) item.poster = image(raw.cover);
        if (raw.desc) item.overview = cleanText(raw.desc).slice(0, 600);
        const score = Number(raw.media_score && raw.media_score.score);
        if (Number.isFinite(score) && score > 0) item.rating = score;
        if (Array.isArray(raw.badges) && raw.badges.length > 0) {
          const badges = raw.badges.map((b) => cleanText(b && b.text)).filter(Boolean);
          if (badges.length > 0) item.badges = badges;
        }
        items.push(item);
      }
      const numPages = Number(data.numPages) || 0;
      const hasNext = numPages > page && page < MAX_SEARCH_PAGE;
      return { items: uniqueById(items), next: hasNext ? String(page + 1) : null };
    }

    const url = signedUrl(ctx, mixin, `${API}/x/web-interface/wbi/search/type`, {
      search_type: 'video',
      keyword,
      page,
      page_size: PAGE_SIZE,
    });
    const j = await requestJson(ctx, url, { referer: SEARCH_REFERER });
    if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
    const data = j.data || {};
    const list = Array.isArray(data.result) ? data.result : [];
    const items = [];
    for (const raw of list) {
      const item = mapArchiveItem(ctx, raw);
      if (item) items.push(item);
    }
    const numPages = Number(data.numPages) || 0;
    const hasNext = numPages > page && page < MAX_SEARCH_PAGE;
    return { items: uniqueById(items), next: hasNext ? String(page + 1) : null };
  },

  async suggest(ctx, { query = '' } = {}) {
    const term = String(query || '').trim();
    if (!term) return [];
    let j;
    try {
      j = await requestJson(
        ctx,
        `${SUGGEST_API}/main/suggest?term=${encodeURIComponent(term)}&main_ver=v1`,
        { referer: SEARCH_REFERER },
      );
    } catch (err) {
      ctx.log.debug(`bilibili suggest failed: ${err.message || err}`);
      return [];
    }
    const tags = j && j.result && Array.isArray(j.result.tag) ? j.result.tag : [];
    const out = [];
    for (const tag of tags) {
      const value = cleanText(tag && (tag.value || tag.term || tag.name));
      if (value && out.indexOf(value) < 0) out.push(value);
      if (out.length >= 8) break;
    }
    return out;
  },

  async reportProgress(
    ctx,
    { itemId, positionMs = 0, durationMs = 0, event = 'progress', session = null },
  ) {
    const current = await getSession(ctx);
    if (!current) return; // anonymous play has no account history to update
    if (!current.biliJct) return;

    const meta = await playbackMeta(ctx, itemId);
    const progress = Math.max(0, Math.round(Number(positionMs) / 1000));
    const csrf = encodeURIComponent(current.biliJct);
    const parts = [];
    if (meta.kind === 'pgc') {
      parts.push(`epid=${encodeURIComponent(meta.epId)}`);
      if (meta.seasonId) parts.push(`sid=${encodeURIComponent(meta.seasonId)}`);
    } else {
      parts.push(`aid=${encodeURIComponent(meta.aid)}`);
    }
    parts.push(`cid=${encodeURIComponent(meta.cid)}`);
    parts.push(`progress=${progress}`);
    parts.push(`csrf=${csrf}`);

    const j = await requestJson(ctx, `${API}/x/v2/history/report`, {
      method: 'POST',
      auth: true,
      requireAuth: true,
      contentType: 'application/x-www-form-urlencoded',
      body: parts.join('&'),
      referer: REFERER,
    });
    if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  },

  async setFavorite(ctx, { itemId, favorite }) {
    const session = await requireSession(ctx);
    const id = String(itemId || '');
    if (id.indexOf('v:') !== 0) {
      throw new ctx.Error('Unsupported', ctx.t('err_fav_unsupported'));
    }
    if (!session.biliJct) throw new ctx.Error('NeedsAuth', ctx.t('err_needs_auth'));

    const meta = await playbackMeta(ctx, id);
    const folders = await favFolderList(ctx);
    if (folders.length === 0) {
      throw new ctx.Error('Unavailable', ctx.t('err_unexpected'));
    }
    const folderId = folders[0].id;

    const parts = [
      `rid=${encodeURIComponent(meta.aid)}`,
      'type=2',
      'platform=web',
      favorite
        ? `add_media_ids=${encodeURIComponent(folderId)}`
        : `del_media_ids=${encodeURIComponent(folderId)}`,
      `csrf=${encodeURIComponent(session.biliJct)}`,
    ];
    const j = await requestJson(ctx, `${API}/x/v3/fav/resource/deal`, {
      method: 'POST',
      auth: true,
      requireAuth: true,
      contentType: 'application/x-www-form-urlencoded',
      body: parts.join('&'),
      referer: REFERER,
    });
    if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
  },

  async loginStart(ctx) {
    const j = await requestJson(
      ctx,
      `${PASSPORT}/x/passport-login/web/qrcode/generate?source=main-fe-header`,
      { auth: true, referer: REFERER },
    );
    if (j.code !== 0) mapApiCode(ctx, j.code, j.message);
    const data = j.data || {};
    if (!data.url || !data.qrcode_key) {
      throw new ctx.Error('Unavailable', ctx.t('err_unexpected'));
    }
    return {
      qr: fitQrPayload(ctx, data.url, data.qrcode_key),
      hint: ctx.t('qr_hint'),
      expiresInSec: 180,
      state: String(data.qrcode_key),
    };
  },

  async loginPoll(ctx, { state } = {}) {
    const key = String(state || '').trim();
    if (!key) throw new ctx.Error('AuthFailed', ctx.t('err_auth_failed'));

    const j = await requestJson(
      ctx,
      `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}&source=main-fe-header`,
      { auth: true, referer: REFERER },
    );
    if (j.code !== 0) {
      if (j.code === -400 || j.code === -101) {
        throw new ctx.Error('AuthFailed', ctx.t('err_auth_failed'));
      }
      mapApiCode(ctx, j.code, j.message);
    }

    const data = j.data || {};
    const code = Number(data.code);
    if (code === 86101) return { status: 'pending' };
    if (code === 86090) return { status: 'scanned' };
    if (code === 86038) return { status: 'expired' };
    if (code !== 0) return { status: 'pending' };

    const params = parseUrlParams(data.url);
    let sessdata = params.SESSDATA || '';
    let biliJct = params.bili_jct || '';
    let mid = params.DedeUserID || '';

    if (!sessdata) {
      const jar = await ctx.cookies.get(`${API}/`);
      const cookies = parseCookieHeader(jar);
      sessdata = cookies.SESSDATA || '';
      biliJct = cookies.bili_jct || '';
      mid = cookies.DedeUserID || '';
    }
    if (!sessdata) throw new ctx.Error('AuthFailed', ctx.t('err_auth_failed'));

    const session = {
      sessdata,
      biliJct,
      mid,
      savedAt: Date.now(),
    };
    // Persist before the profile probe so requestJson() can attach the cookie.
    await ctx.storage.set('session', session);
    let user;
    try {
      user = await fetchProfile(ctx, session);
    } catch (err) {
      await ctx.storage.remove('session');
      throw err;
    }
    await ctx.storage.set('session', session);

    const cookieParts = [`SESSDATA=${session.sessdata}`];
    if (session.biliJct) cookieParts.push(`bili_jct=${session.biliJct}`);
    if (session.mid) cookieParts.push(`DedeUserID=${session.mid}`);
    try {
      await ctx.cookies.set(
        `${API}/`,
        `${cookieParts.join('; ')}; Path=/; Domain=.bilibili.com; Secure`,
      );
    } catch (err) {
      // The cookie jar is a convenience only; requests use the stored session.
      ctx.log.debug(`bilibili cookie jar update skipped: ${err.message || err}`);
    }

    return { status: 'done', user };
  },

  async logout(ctx) {
    await ctx.storage.remove('session');
    await ctx.cookies.clear();
  },
};
