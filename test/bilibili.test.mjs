// Recorded regression for the Bilibili plugin.
//
// Runs the real plugin inside the kit's QuickJS runtime with a transport that
// serves plugins/bilibili/fixtures/recorded-responses.json, so the whole flow is
// offline and deterministic: anonymous browsing, WBI-signed playback, QR login,
// history/favorites/progress, expired sessions and token privacy.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  checkPlugin,
  loadPluginSource,
  PluginCallError,
  PluginStorage,
  QuickJsPluginHost,
  repoRoot,
  validateProtocolType,
} from '../lib/kit.mjs';

const PLUGIN_DIR = path.join(repoRoot, 'plugins/bilibili');
const FIXTURES = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_DIR, 'fixtures/recorded-responses.json'), 'utf8'),
);

test('bilibili plugin passes static check and recorded anonymous + QR login flow (WBI, DASH, token privacy)', async () => {
  const ids = FIXTURES._meta.ids;
  // Feed/list fixtures carry synthetic bvids that have no hand-written view fixture;
  // synthesize one so detail()/playback() can be exercised for any of them.
  const archiveByBvid = new Map();
  for (const bucket of ['recommend', 'recommendMore', 'popular', 'ranking', 'newlist']) {
    for (const raw of FIXTURES[bucket].data.item || FIXTURES[bucket].data.list ||
      FIXTURES[bucket].data.archives || []) {
      if (raw && raw.bvid) archiveByBvid.set(raw.bvid, raw);
    }
  }
  const synthesizedView = (bvid) => {
    const raw = archiveByBvid.get(bvid);
    if (!raw) return null;
    const cid = Number(raw.cid) || 770500;
    return {
      code: 0,
      message: '0',
      ttl: 1,
      data: {
        aid: Number(raw.aid) || 889000,
        bvid,
        cid,
        videos: 1,
        tid: Number(raw.tid) || 188,
        tname: raw.tname || '科技',
        pic: raw.pic || '',
        title: raw.title || bvid,
        pubdate: Number(raw.pubdate) || 1700000000,
        desc: raw.desc || '',
        duration: Number(raw.duration) || 600,
        owner: raw.owner || { mid: 42, name: '测试UP主' },
        stat: raw.stat || { view: 1, danmaku: 0, like: 0 },
        pages: [{ cid, page: 1, from: 'vupload', part: '正片', duration: Number(raw.duration) || 600 }],
      },
    };
  };
  const tokenPattern = /SESSDATA|fakecsrf|fake%2Csession/;
  const calls = [];
  const logs = [];
  const state = { qrStep: 0, forceExpired: false, bodies: [] };

  const makeTransport = (sink) => async ({ url, method, headers, body }) => {
    const p = url.pathname;
    const qs = url.searchParams;
    const cookie = String(headers.Cookie || '');
    if (sink) {
      sink.push({
        method,
        path: p,
        query: Object.fromEntries(qs.entries()),
        cookie,
        headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
      });
    }
    const json = (data, status = 200) => ({
      status,
      headers: { 'content-type': 'application/json' },
      setCookies: [],
      body: Buffer.from(JSON.stringify(data), 'utf8'),
    });
    const authed =
      /SESSDATA=fake%2Csession%2Cdata\*11/.test(cookie) && !state.forceExpired;

    if (p === '/x/web-interface/nav') {
      return json(authed ? FIXTURES.navLoggedIn : FIXTURES.navAnonymous);
    }
    if (p === '/x/web-interface/index/top/feed/rcmd') {
      return json(qs.get('fresh_idx') === '1' ? FIXTURES.recommend : FIXTURES.recommendMore);
    }
    if (p === '/x/web-interface/popular') return json(FIXTURES.popular);
    if (p === '/x/web-interface/ranking/v2') return json(FIXTURES.ranking);
    if (p === '/x/web-interface/newlist') return json(FIXTURES.newlist);
    if (p === '/x/web-interface/view') {
      const bvid = qs.get('bvid');
      const view = FIXTURES.views[bvid] || synthesizedView(bvid);
      return json(view || FIXTURES.notFound);
    }
    if (p === '/x/web-interface/archive/related') return json(FIXTURES.related);
    if (p === '/x/player/wbi/playurl') {
      if (!qs.get('w_rid') || !qs.get('wts')) return json({ code: -400, message: 'missing wbi' });
      return json(qs.get('qn') === '16' ? FIXTURES.ugcPlayurl360 : FIXTURES.ugcPlayurl);
    }
    if (p === '/x/player/wbi/v2') {
      return json({ code: 0, data: { subtitle: { subtitles: [] } } });
    }
    if (p === '/pgc/web/rank/list') {
      return json(qs.get('season_type') === '2' ? FIXTURES.pgcRankMovie : FIXTURES.pgcRank);
    }
    if (p === '/pgc/view/web/season') {
      if (qs.get('ep_id') && Number(qs.get('ep_id')) === ids.missingEpId) {
        return json(FIXTURES.notFound);
      }
      return json(FIXTURES.season);
    }
    if (p === '/pgc/player/web/playurl') {
      const epId = Number(qs.get('ep_id'));
      if (epId === ids.previewEpId) return json(FIXTURES.pgcPlayurlPreview);
      if (epId === ids.drmEpId) return json(FIXTURES.pgcPlayurlDrm);
      if (epId === ids.missingEpId) return json(FIXTURES.notFound);
      return json(FIXTURES.pgcPlayurl);
    }
    if (p === '/x/web-interface/wbi/search/type') {
      if (!qs.get('w_rid') || !qs.get('wts')) return json({ code: -400, message: 'missing wbi' });
      return json(
        qs.get('search_type') === 'media_bangumi'
          ? FIXTURES.bangumiSearch
          : FIXTURES.search,
      );
    }
    if (p === '/main/suggest') return json(FIXTURES.suggest);
    if (p === '/x/passport-login/web/qrcode/generate') return json(FIXTURES.qrGenerate);
    if (p === '/x/passport-login/web/qrcode/poll') {
      const step = state.qrStep;
      state.qrStep += 1;
      if (step === 0) return json(FIXTURES.qrPollPending);
      if (step === 1) return json(FIXTURES.qrPollScanned);
      return json(FIXTURES.qrPollSuccess);
    }
    if (p === '/x/web-interface/history/cursor') {
      return authed ? json(FIXTURES.history) : json({ code: -101, message: '账号未登录' });
    }
    if (p === '/x/v3/fav/folder/created/list-all') {
      return authed ? json(FIXTURES.favFolders) : json({ code: -101, message: '账号未登录' });
    }
    if (p === '/x/v3/fav/resource/list') {
      return authed ? json(FIXTURES.favList) : json({ code: -101, message: '账号未登录' });
    }
    if (p === '/x/v3/fav/resource/deal') {
      state.bodies.push({ path: p, body: String(body || '') });
      return authed ? json(FIXTURES.favDeal) : json({ code: -101, message: '账号未登录' });
    }
    if (p === '/x/v2/history/report') {
      state.bodies.push({ path: p, body: String(body || '') });
      return authed ? json(FIXTURES.historyReport) : json({ code: -101, message: '账号未登录' });
    }
    if (p === '/x/v2/dm/web/seg.so') {
      const key = `${qs.get('oid')}:${qs.get('segment_index')}`;
      const encoded = FIXTURES.danmakuSegments[key];
      if (!encoded) {
        // Bilibili answers 304 with an empty body past the last segment.
        return { status: 304, headers: {}, setCookies: [], body: Buffer.alloc(0) };
      }
      return {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        setCookies: [],
        body: Buffer.from(encoded, 'base64'),
      };
    }
    return json({ code: -404, message: `unhandled mock path: ${p}` });
  };

  const staticCheck = await checkPlugin(PLUGIN_DIR, {
    config: { quality: 'auto' },
    dnsResolver: async () => ['104.16.0.1'],
    transportOverride: makeTransport(null),
  });
  assert.equal(staticCheck.ok, true, `bilibili check failed: ${staticCheck.errors.join('; ')}`);

  state.qrStep = 0;
  state.bodies.length = 0;

  const loaded = await loadPluginSource(PLUGIN_DIR);
  const storage = new PluginStorage();
  const host = new QuickJsPluginHost({
    manifest: loaded.manifest,
    mainJs: loaded.mainJs,
    locale: loaded.locale,
    storage,
    config: { quality: 'auto' },
    device: {
      appVersion: '1.0.0',
      locale: 'zh-CN',
      model: 'depth3d-kit',
      maxWidth: 3840,
      maxHeight: 2160,
      codecs: ['avc', 'hevc'],
      hdr: true,
    },
    dnsResolver: async () => ['104.16.0.1'],
    transportOverride: makeTransport(calls),
    logSink: (line) => logs.push(line),
  });

  try {
    // ---- anonymous browsing ------------------------------------------------
    const home = await host.invoke('home');
    assert.equal(validateProtocolType('HomeResult', home).valid, true);
    assert.deepEqual(
      home.map((shelf) => shelf.id),
      ['bili-recommend', 'bili-popular', 'bili-ranking', 'bili-bangumi', 'bili-regions'],
    );
    assert.equal(home[0].items.length, 20, 'live recommendation must be filtered out');
    assert.equal(home[2].items.length, 20, 'ranking rail shows the first page only');
    assert.equal(home[3].items.length, 20, 'bangumi rail shows the first page only');
    assert.equal(home[0].items[0].id, 'v:BV1d3Rec0000');
    assert.equal(tokenPattern.test(JSON.stringify(home)), false);
    // The wall keys rows by `${source.id}/${shelf.category.id}` (HomeScreen.kt),
    // so two shelves sharing `more` crash the list.
    const moreIds = home.filter((s) => s.more).map((s) => s.more);
    assert.equal(new Set(moreIds).size, moreIds.length, 'shelf `more` must be unique');
    for (const shelf of home) {
      const shelfItemIds = shelf.items.map((it) => it.id);
      assert.equal(new Set(shelfItemIds).size, shelfItemIds.length, `duplicate item id in ${shelf.id}`);
    }

    const root = await host.invoke('browse', { categoryId: '' });
    assert.equal(validateProtocolType('ItemPage', root).valid, true);
    assert.equal(root.items.length, 19);

    const recommendPage = await host.invoke('browse', { categoryId: 'recommend' });
    assert.equal(recommendPage.items.length, 20);
    assert.equal(recommendPage.next, '2', 'a full recommendation batch must continue the feed');
    const recommendMore = await host.invoke('browse', { categoryId: 'recommend', cursor: '2' });
    assert.equal(recommendMore.items.length, 5);
    assert.equal(recommendMore.next, null);
    assert.equal(
      new Set([...recommendPage.items, ...recommendMore.items].map((it) => it.id)).size,
      25,
      'recommendation pages must not repeat items',
    );
    assert.ok(
      calls.some((c) => c.path === '/x/web-interface/index/top/feed/rcmd' && c.query.fresh_idx === '1'),
      'recommendation feed must be requested with fresh_idx',
    );

    const popular = await host.invoke('browse', { categoryId: 'popular' });
    assert.equal(popular.items.length, 2);
    assert.equal(popular.next, null);

    const region = await host.invoke('browse', { categoryId: 'region:1', cursor: '2' });
    assert.equal(region.items.length, 1);
    assert.equal(region.next, null);

    // Endless scroll: every category must hand back a cursor until it is exhausted
    // (LibraryScreen keeps calling browse(categoryId, page) while nextPage != null).
    const bangumi = await host.invoke('browse', { categoryId: 'bangumi' });
    assert.equal(bangumi.items.length, 20);
    assert.equal(bangumi.next, '20');
    assert.ok(bangumi.items.every((it) => it.kind === 'series' && it.id.startsWith('ss:')));
    const bangumiLast = await host.invoke('browse', { categoryId: 'bangumi', cursor: '20' });
    assert.equal(bangumiLast.items.length, 5);
    assert.equal(bangumiLast.next, null);
    assert.equal(
      new Set([...bangumi.items, ...bangumiLast.items].map((it) => it.id)).size,
      25,
      'paged slices must not overlap',
    );

    const rankingFirst = await host.invoke('browse', { categoryId: 'ranking' });
    assert.equal(rankingFirst.items.length, 20);
    assert.equal(rankingFirst.next, '20');
    const rankingLast = await host.invoke('browse', { categoryId: 'ranking', cursor: '20' });
    assert.equal(rankingLast.items.length, 5);
    assert.equal(rankingLast.next, null);

    const movies = await host.invoke('browse', { categoryId: 'movie' });
    assert.equal(movies.items.length, 2);
    assert.equal(movies.next, null, 'a chart shorter than one page ends immediately');

    // ---- details ----------------------------------------------------------
    const multi = await host.invoke('detail', { itemId: `v:${ids.multiBvid}` });
    assert.equal(validateProtocolType('Item', multi).valid, true);
    assert.deepEqual(
      multi.episodes.map((e) => e.id),
      [`v:${ids.multiBvid}:1`, `v:${ids.multiBvid}:2`],
    );
    const page2 = await host.invoke('detail', { itemId: `v:${ids.multiBvid}:2` });
    assert.equal(page2.kind, 'episode');
    assert.equal(page2.parentId, `v:${ids.multiBvid}`);
    assert.equal(page2.durationMs, 600000);
    const ugc = await host.invoke('detail', { itemId: `v:${ids.seasonBvid}` });
    assert.equal(ugc.episodes.length, 2);
    assert.ok(ugc.badges.includes('合集'));

    const series = await host.invoke('detail', { itemId: `ss:${ids.seasonId}` });
    assert.equal(series.kind, 'series');
    assert.equal(series.seasons.length, 2);
    assert.equal(series.seasons[0].id, `sg:${ids.seasonId}`);
    const season = await host.invoke('detail', { itemId: `sg:${ids.seasonId}` });
    assert.equal(season.kind, 'season');
    assert.deepEqual(
      season.episodes.map((e) => e.id),
      [ids.epId, ids.epId2, ids.previewEpId, ids.drmEpId].map((n) => `ep:${n}`),
    );
    assert.equal(season.episodes[0].title, '第 1 话 · 启程');
    const episode = await host.invoke('detail', { itemId: `ep:${ids.epId}` });
    assert.equal(episode.kind, 'episode');
    assert.equal(episode.parentId, `sg:${ids.seasonId}`);

    // ---- playback: separated DASH, codec filtering, quality lock ----------
    const pb = await host.invoke('playback', { itemId: `v:${ids.singleBvid}` });
    assert.equal(validateProtocolType('PlaybackInfo', pb).valid, true);
    assert.equal(pb.durationMs, 600000);
    assert.equal(pb.dash.video.length, 3, 'av1 must be filtered out for avc+hevc device');
    assert.equal(
      pb.dash.video.some((v) => v.codecs.startsWith('av01')),
      false,
    );
    assert.equal(pb.dash.audio.length, 2);
    assert.equal(pb.qualities.find((q) => q.selected).id, '32');
    assert.equal(pb.qualities.find((q) => q.id === '80').locked, '登录后可看');
    assert.equal(pb.headers.Referer, 'https://www.bilibili.com/');
    assert.equal('Cookie' in pb.headers, false, 'stream headers must not carry the login cookie');
    assert.equal(tokenPattern.test(JSON.stringify(pb)), false);
    const v32 = pb.dash.video.find((v) => v.quality === '32' && v.id.endsWith('avc'));
    assert.equal(v32.initRange, '0-935');
    assert.equal(v32.indexRange, '936-1251');
    assert.deepEqual(v32.backupUrls, ['https://upos-fake2.bilivideo.com/ugc/v32-avc.m4s']);

    const pb360 = await host.invoke('playback', { itemId: `v:${ids.singleBvid}`, quality: '16' });
    assert.equal(pb360.qualities.find((q) => q.selected).id, '16');
    assert.equal(pb360.qualities.find((q) => q.id === '32').locked, '登录后可看');
    assert.equal(pb360.dash.video.length, 1);

    const pgc = await host.invoke('playback', { itemId: `ep:${ids.epId}` });
    assert.equal(pgc.durationMs, 1440000);
    assert.equal(pgc.next, `ep:${ids.epId2}`);
    assert.equal(pgc.dash.video.length, 1);

    await assert.rejects(
      () => host.invoke('playback', { itemId: `ep:${ids.previewEpId}` }),
      (e) => e instanceof PluginCallError && e.code === 'Forbidden',
    );
    await assert.rejects(
      () => host.invoke('playback', { itemId: `ep:${ids.drmEpId}` }),
      (e) => e instanceof PluginCallError && e.code === 'Unsupported',
    );
    await assert.rejects(
      () => host.invoke('playback', { itemId: `ep:${ids.missingEpId}` }),
      (e) => e instanceof PluginCallError && e.code === 'NotFound',
    );

    // ---- danmaku (protobuf segments) ---------------------------------------
    const dm = await host.invoke('danmaku', { itemId: `v:${ids.singleBvid}`, fromMs: 0, toMs: 60000 });
    assert.equal(validateProtocolType('DanmakuResult', dm).valid, true);
    assert.ok(dm.length > 0, 'danmaku must come back for a video with recorded segments');
    assert.ok(dm.every((d) => d.timeMs >= 0 && d.timeMs < 60000), 'items outside the window must be dropped');
    assert.deepEqual(
      dm.map((d) => d.timeMs),
      [...dm.map((d) => d.timeMs)].sort((a, b) => a - b),
      'danmaku must be sorted by time',
    );
    assert.equal(dm.find((d) => d.text === '红色滚动弹幕').color, 0xff0000);
    assert.equal(dm.find((d) => d.text === '顶部弹幕').mode, 'top');
    assert.equal(dm.find((d) => d.text === '底部弹幕').mode, 'bottom');
    assert.equal(dm.find((d) => d.text === '逆向弹幕按滚动处理').mode, 'scroll');
    assert.equal(dm.some((d) => d.text.includes('高级弹幕')), false, 'mode 7 has no plain-text form');
    assert.equal(dm.filter((d) => d.text === '重复条目').length, 1, 'duplicate ids must be collapsed');
    assert.equal(dm.some((d) => d.text.trim() === ''), false, 'empty danmaku must be dropped');
    assert.equal(tokenPattern.test(JSON.stringify(dm)), false);

    const dmCalls = calls.filter((c) => c.path === '/x/v2/dm/web/seg.so');
    assert.deepEqual(dmCalls.map((c) => c.query.segment_index), ['1'], 'only the covered segment is fetched');
    assert.equal(dmCalls[0].query.oid, String(ids.cid));
    assert.equal(dmCalls[0].query.pid, String(ids.aid));
    assert.equal('cookie' in dmCalls[0].headers, false, 'danmaku requests must not carry the login cookie');
    assert.equal(dmCalls[0].headers['accept-encoding'], 'identity');

    // A window crossing the 6-minute boundary pulls the second segment and keeps
    // only what falls inside the requested range.
    const dmCross = await host.invoke('danmaku', { itemId: `v:${ids.singleBvid}`, fromMs: 355000, toMs: 400000 });
    assert.ok(dmCross.length > 0);
    assert.ok(dmCross.every((d) => d.timeMs >= 355000 && d.timeMs < 400000));
    const crossSegments = calls
      .filter((c) => c.path === '/x/v2/dm/web/seg.so')
      .map((c) => c.query.segment_index);
    assert.ok(crossSegments.includes('1') && crossSegments.includes('2'), `expected both segments, got ${crossSegments}`);
    // The first segment is cached for the runtime: no duplicate fetch of '1'.
    assert.equal(crossSegments.filter((i) => i === '1').length, 1, 'segments are cached per runtime');

    // Beyond the item duration there is nothing to ask for.
    const dmPast = await host.invoke('danmaku', { itemId: `v:${ids.singleBvid}`, fromMs: 900000, toMs: 960000 });
    assert.deepEqual(dmPast, []);

    // A video with no recorded segments answers 304 per segment: empty, not an error.
    const dmNone = await host.invoke('danmaku', { itemId: `v:${ids.multiBvid}`, fromMs: 0, toMs: 60000 });
    assert.deepEqual(dmNone, []);

    // ---- search / suggest -------------------------------------------------
    const search = await host.invoke('search', { query: '深度' });
    assert.equal(search.items.length, 1, 'duplicate ids must be collapsed before reaching the wall');
    assert.equal(search.items[0].title.includes('<em'), false, 'search titles must be cleaned');
    assert.equal(search.next, '2');
    const seriesSearch = await host.invoke('search', { query: '深度', kind: 'series' });
    assert.equal(seriesSearch.items[0].id, `ss:${ids.seasonId}`);
    assert.deepEqual(await host.invoke('suggest', { query: '深' }), ['深度测试', '深度估计']);

    // ---- WBI signature was actually applied -------------------------------
    const wbiCalls = calls.filter(
      (c) =>
        c.path === '/x/player/wbi/playurl' ||
        c.path === '/x/web-interface/wbi/search/type',
    );
    assert.ok(wbiCalls.length >= 4);
    for (const c of wbiCalls) {
      assert.ok(c.query.w_rid && c.query.wts, `${c.path} must be WBI-signed`);
    }

    // ---- QR login ---------------------------------------------------------
    const qr = await host.invoke('loginStart');
    assert.equal(validateProtocolType('QrLoginStartResult', qr).valid, true);
    assert.equal(qr.state, 'FAKEQRKEY0123456789abcdef0123456');
    assert.equal(qr.qr.includes('FAKEQRKEY0123456789abcdef0123456'), true);
    // Host QR encoder (QrCodeMatrix.kt) only handles versions 1..6 = 134 bytes
    // and throws `IllegalArgumentException` (crashing the App) above that.
    assert.ok(
      Buffer.byteLength(qr.qr, 'utf8') <= 134,
      `QR payload must fit the host encoder, got ${Buffer.byteLength(qr.qr, 'utf8')} bytes`,
    );
    assert.equal(qr.qr.includes('from=main-fe-header'), false, 'analytics param must be trimmed');
    assert.equal((await host.invoke('loginPoll', { state: qr.state })).status, 'pending');
    assert.equal((await host.invoke('loginPoll', { state: qr.state })).status, 'scanned');
    const done = await host.invoke('loginPoll', { state: qr.state });
    assert.equal(validateProtocolType('LoginPollResult', done).valid, true);
    assert.equal(done.status, 'done');
    assert.equal(done.user.name, '深度测试员');
    assert.deepEqual(storage.keys(), ['session']);
    const session = storage.get('session');
    assert.equal(session.sessdata, 'fake%2Csession%2Cdata*11');
    assert.equal(session.biliJct, 'fakecsrf');
    assert.equal(session.mid, '123456789');

    // ---- authenticated shelves -------------------------------------------
    const home2 = await host.invoke('home');
    assert.equal(home2[0].id, 'bili-history');
    assert.equal(home2[0].style, 'continue');
    assert.equal(home2[0].items[0].progressMs, 120000);
    assert.equal(tokenPattern.test(JSON.stringify(home2)), false);
    const history = await host.invoke('browse', { categoryId: 'history' });
    assert.equal(history.items.length, 1);
    const favs = await host.invoke('browse', { categoryId: 'favs' });
    assert.equal(favs.items.length, 1);
    assert.equal(favs.items[0].id, `fav:${ids.favFolderId}`);
    const favItems = await host.invoke('browse', { categoryId: `fav:${ids.favFolderId}` });
    assert.equal(favItems.items.length, 1);
    assert.equal(favItems.items[0].id, `v:${ids.singleBvid}`);

    // ---- progress + favorites --------------------------------------------
    await host.invoke('reportProgress', {
      itemId: `v:${ids.multiBvid}`,
      positionMs: 60000,
      durationMs: 600000,
      event: 'progress',
    });
    const report = state.bodies.find((b) => b.path === '/x/v2/history/report');
    assert.ok(report, 'history report must be sent for a logged-in user');
    assert.ok(report.body.includes('aid=880002'));
    assert.ok(report.body.includes('cid=770002'));
    assert.ok(report.body.includes('progress=60'));
    assert.ok(report.body.includes('csrf=fakecsrf'));

    await host.invoke('setFavorite', { itemId: `v:${ids.singleBvid}`, favorite: true });
    await host.invoke('setFavorite', { itemId: `v:${ids.singleBvid}`, favorite: false });
    const deals = state.bodies.filter((b) => b.path === '/x/v3/fav/resource/deal');
    assert.equal(deals.length, 2);
    assert.ok(deals[0].body.includes('rid=880001'));
    assert.ok(deals[0].body.includes('add_media_ids=555001'));
    assert.ok(deals[0].body.includes('csrf=fakecsrf'));
    assert.ok(deals[1].body.includes('del_media_ids=555001'));
    await assert.rejects(
      () => host.invoke('setFavorite', { itemId: `ep:${ids.epId}`, favorite: true }),
      (e) => e instanceof PluginCallError && e.code === 'Unsupported',
    );

    // ---- expired session --------------------------------------------------
    state.forceExpired = true;
    await assert.rejects(
      () => host.invoke('browse', { categoryId: 'history' }),
      (e) => e instanceof PluginCallError && e.code === 'NeedsAuth',
    );
    await assert.rejects(
      () => host.invoke('home'),
      (e) => e instanceof PluginCallError && e.code === 'NeedsAuth',
    );
    state.forceExpired = false;

    // ---- logout keeps anonymous browsing working -------------------------
    await host.invoke('logout');
    assert.equal(storage.get('session'), null);
    const home3 = await host.invoke('home');
    assert.equal(home3[0].id, 'bili-recommend');

    // ---- no token may ever reach a title/description/log -----------------
    for (const line of logs) {
      const text = typeof line === 'string' ? line : JSON.stringify(line);
      assert.equal(tokenPattern.test(text), false, `log leaked a token: ${text}`);
    }
  } finally {
    await host.dispose();
  }
});
