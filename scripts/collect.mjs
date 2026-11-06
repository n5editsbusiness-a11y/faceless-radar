#!/usr/bin/env node
/**
 * Daily collector for Faceless Radar.
 *
 *   YOUTUBE_API_KEY=... node scripts/collect.mjs        full run
 *   node scripts/collect.mjs --offline                   rebuild derived files, no API calls
 *
 * Stages: discover channels by niche search -> refresh channel stats and recent uploads
 * -> compute outlier scores and niche metrics -> write site/data/*.json.
 * Environment overrides (used by tests): DATA_DIR, STATE_DIR, CONFIG_DIR, YT_API_BASE, SHORTS_CHECK_BASE.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson, writeJsonRows } from './lib/io.mjs';
import { median, mean, clamp, round, parseDuration, DAY_MS, daysBetween } from './lib/stats.mjs';
import { YouTube, QuotaError } from './lib/yt.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const abs = (envName, fallback) => (process.env[envName] ? path.resolve(process.env[envName]) : fallback);
const DATA = abs('DATA_DIR', path.join(ROOT, 'site', 'data'));
const STATE_FILE = path.join(abs('STATE_DIR', path.join(ROOT, 'state')), 'state.json');
const CONFIG = abs('CONFIG_DIR', path.join(ROOT, 'config'));
const OFFLINE = process.argv.includes('--offline');

const settings = readJson(path.join(CONFIG, 'settings.json'));
const niches = readJson(path.join(CONFIG, 'niches.json'));
const now = Date.now();
const today = new Date(now).toISOString().slice(0, 10);

const log = (...a) => console.log('[collect]', ...a);
const warn = (...a) => console.warn('[collect] warning:', ...a);

// ---------- validation ----------
{
  const seen = new Set();
  for (const n of niches) {
    if (!n.id || !n.name || !Array.isArray(n.queries) || !n.queries.length) {
      throw new Error(`config/niches.json: niche "${n.id ?? '?'}" needs id, name and at least one query`);
    }
    if (seen.has(n.id)) throw new Error(`config/niches.json: duplicate niche id "${n.id}"`);
    seen.add(n.id);
  }
}
const nicheById = new Map(niches.map((n) => [n.id, n]));

// ---------- previous state ----------
const prevNiches = readJson(path.join(DATA, 'niches.json'), []);
const prevChannelRows = readJson(path.join(DATA, 'channels.json'), []);
const prevVideoRows = readJson(path.join(DATA, 'videos.json'), []);
const prevFeed = readJson(path.join(DATA, 'feed.json'), []);
const reviews = readJson(path.join(DATA, 'reviews.json'), { channels: {}, videos: {} });
const state = readJson(STATE_FILE, { version: 1, queries: {}, channels: {}, formats: {} });
state.queries ||= {};
state.channels ||= {};
state.formats ||= {};

const isRejected = (id) => reviews.channels?.[id]?.faceless === false;
const channels = new Map(prevChannelRows.map((c) => [c.id, c]));
const videoPool = new Map(prevVideoRows.map((v) => [v.id, v]));
const prevVideoIds = new Set(prevVideoRows.map((v) => v.id));

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const ageDays = (iso) => daysBetween(Date.parse(iso), now);

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

// ---------- stage 1: discovery ----------
function buildTasks() {
  const tasks = [];
  niches.forEach((niche, order) => {
    for (const kind of ['long', 'short']) {
      const key = `${niche.id}|${kind}`;
      const st = state.queries[key] || { lastRun: null, idx: 0 };
      tasks.push({ niche, kind, key, lastRun: st.lastRun || '', idx: st.idx || 0, order });
    }
  });
  tasks.sort(
    (a, b) =>
      a.lastRun.localeCompare(b.lastRun) || (a.kind === b.kind ? 0 : a.kind === 'long' ? -1 : 1) || a.order - b.order,
  );
  return tasks;
}

function nicheCount(nicheId) {
  let n = 0;
  for (const c of Object.values(state.channels)) if (c.nicheIds.includes(nicheId)) n++;
  return n;
}

async function discover(yt) {
  const tasks = buildTasks().slice(0, settings.maxSearchesPerRun);
  const publishedAfter = new Date(now - settings.windowDays * DAY_MS).toISOString();
  let found = 0;
  for (const task of tasks) {
    const { niche, kind } = task;
    const q = niche.queries[task.idx % niche.queries.length];
    const duration = kind === 'short' ? 'short' : niche.docs && task.idx % 2 === 1 ? 'long' : 'medium';
    let res;
    try {
      res = await yt.search({
        part: 'snippet',
        type: 'video',
        q: kind === 'short' ? `${q} #shorts` : q,
        order: 'viewCount',
        maxResults: 50,
        publishedAfter,
        regionCode: settings.region,
        relevanceLanguage: settings.relevanceLanguage,
        videoDuration: duration,
      });
    } catch (err) {
      if (err instanceof QuotaError) throw err;
      warn(`search failed for "${niche.id}" (${kind}): ${err.message}`);
      continue;
    }
    state.queries[task.key] = { lastRun: today, idx: task.idx + 1 };
    for (const item of res.items || []) {
      const channelId = item.snippet?.channelId;
      if (!channelId || isRejected(channelId)) continue;
      let st = state.channels[channelId];
      if (!st) {
        if (nicheCount(niche.id) >= settings.maxChannelsPerNiche) continue;
        st = state.channels[channelId] = { nicheIds: [], firstSeen: today, lastSeen: today, lastFetched: null };
        found++;
      }
      st.lastSeen = today;
      if (!st.nicheIds.includes(niche.id) && nicheCount(niche.id) < settings.maxChannelsPerNiche) {
        st.nicheIds.push(niche.id);
      }
    }
  }
  // A channel that found no room in any niche is dropped.
  for (const [id, st] of Object.entries(state.channels)) if (!st.nicheIds.length) delete state.channels[id];
  log(`discovery: ${tasks.length} searches, ${found} new channels`);
}

// ---------- stage 2: refresh channels and their recent uploads ----------
// Circuit breaker: if the Shorts URL check keeps failing (blocked or throttled from this network),
// stop trying for the rest of the run and use the 60 second rule instead.
let urlCheckFailures = 0;
let urlCheckOff = false;

async function isShortByUrl(id) {
  if (urlCheckOff) return null;
  const base = process.env.SHORTS_CHECK_BASE || 'https://www.youtube.com/shorts/';
  try {
    const res = await fetch(base + id, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (res.status === 200) {
      urlCheckFailures = 0;
      return true;
    }
    if (res.status >= 300 && res.status < 400) {
      urlCheckFailures = 0;
      return false;
    }
  } catch {
    /* fall through to the duration rule */
  }
  if (++urlCheckFailures >= 8 && !urlCheckOff) {
    urlCheckOff = true;
    warn('Shorts URL check keeps failing from this network; using the 60 second rule for the rest of this run');
  }
  return null;
}

async function classifyFormats(videos) {
  await pool(videos, 8, async (v) => {
    if (v.durationSec > 180) {
      v.format = 'long';
      return;
    }
    let cached = state.formats[v.id];
    if (!cached) {
      const viaUrl = settings.detectShortsViaUrl ? await isShortByUrl(v.id) : null;
      if (viaUrl === null) {
        // The URL check was unavailable: fall back to the 60 second rule and do not cache the guess.
        cached = v.durationSec <= 60 ? 'short' : 'long';
      } else {
        cached = viaUrl ? 'short' : 'long';
        state.formats[v.id] = cached;
      }
    }
    v.format = cached;
  });
}

function toVideo(item) {
  const durationSec = parseDuration(item.contentDetails?.duration);
  const live = item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== 'none';
  if (!durationSec || live || !item.snippet?.publishedAt) return null;
  return {
    id: item.id,
    channelId: item.snippet.channelId,
    title: String(item.snippet.title || '').slice(0, 140),
    publishedAt: item.snippet.publishedAt,
    durationSec,
    views: Number(item.statistics?.viewCount ?? 0),
  };
}

function computeChannel(profile, vids, st) {
  const sorted = [...vids].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  const baseFor = (fmt) => {
    const sample = sorted
      .filter((v) => v.format === fmt && ageDays(v.publishedAt) >= settings.minVideoAgeDays)
      .slice(0, settings.baselineVideos);
    return sample.length >= settings.minBaselineVideos ? median(sample.map((v) => v.views)) : null;
  };
  const baseline = { long: baseFor('long'), short: baseFor('short') };

  const inWindow = sorted.filter((v) => ageDays(v.publishedAt) <= settings.windowDays);
  for (const v of inWindow) {
    const age = ageDays(v.publishedAt);
    v.baseline = baseline[v.format] ?? null;
    v.outlier = v.baseline && v.baseline > 0 && age >= settings.minVideoAgeDays ? round(v.views / v.baseline, 1) : null;
    v.viewsPerDay = Math.round(v.views / Math.max(age, 1));
  }
  const recent60 = inWindow.filter((v) => ageDays(v.publishedAt) <= 60 && v.outlier !== null);
  const last30 = sorted.slice(0, 30);
  const stats = profile.statistics || {};
  const record = {
    id: profile.id,
    title: String(profile.snippet?.title || '').slice(0, 100),
    handle: profile.snippet?.customUrl || null,
    avatar: profile.snippet?.thumbnails?.default?.url || null,
    country: profile.snippet?.country || null,
    createdAt: profile.snippet?.publishedAt || null,
    subs: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount ?? 0),
    totalViews: Number(stats.viewCount ?? 0),
    videoCount: Number(stats.videoCount ?? 0),
    nicheIds: [...st.nicheIds],
    recentVideoCount: inWindow.length,
    uploadsPerWeek: round(sorted.filter((v) => ageDays(v.publishedAt) <= 28).length / 4, 1),
    shortsShare: last30.length ? round(last30.filter((v) => v.format === 'short').length / last30.length, 2) : null,
    medianViews: median(last30.map((v) => v.views)),
    baseline,
    bestOutlier60d: recent60.length ? Math.max(...recent60.map((v) => v.outlier)) : null,
    bestViews90d: inWindow.length ? Math.max(...inWindow.map((v) => v.views)) : 0,
    firstSeen: st.firstSeen,
    lastFetched: today,
  };
  const candidates = inWindow
    .filter((v) => v.outlier !== null)
    .sort((a, b) => b.outlier - a.outlier)
    .slice(0, settings.maxVideosPerChannel)
    .map((v) => ({
      id: v.id,
      channelId: v.channelId,
      title: v.title,
      publishedAt: v.publishedAt,
      durationSec: v.durationSec,
      format: v.format,
      views: v.views,
      baseline: v.baseline,
      outlier: v.outlier,
      viewsPerDay: v.viewsPerDay,
    }));
  return { record, candidates };
}

async function refresh(yt) {
  const ids = Object.entries(state.channels)
    .filter(([id]) => !isRejected(id))
    .sort((a, b) => (a[1].lastFetched || '').localeCompare(b[1].lastFetched || ''))
    .slice(0, settings.maxChannelsPerRun)
    .map(([id]) => id);
  if (!ids.length) return;

  let quotaHit = false;
  const profiles = new Map();
  const uploads = new Map();
  const vmap = new Map();
  try {
    for (const batch of chunk(ids, 50)) {
      const res = await yt.channels(batch);
      for (const item of res.items || []) profiles.set(item.id, item);
    }
    log(`refresh: ${profiles.size} channel profiles loaded, reading uploads`);
    await pool([...profiles.keys()], 5, async (id) => {
      const playlistId = profiles.get(id).contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) return;
      try {
        const res = await yt.playlistItems(playlistId);
        uploads.set(id, (res.items || []).map((i) => i.contentDetails?.videoId).filter(Boolean));
      } catch (err) {
        if (err instanceof QuotaError) throw err;
        warn(`uploads unavailable for channel ${id}: ${err.message}`);
      }
    });
    const allIds = [...new Set([...uploads.values()].flat())];
    log(`refresh: ${allIds.length} videos found, loading stats`);
    for (const batch of chunk(allIds, 50)) {
      const res = await yt.videos(batch);
      for (const item of res.items || []) {
        const v = toVideo(item);
        if (v) vmap.set(v.id, v);
      }
    }
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    quotaHit = true;
    warn(err.message);
  }

  log(`refresh: classifying formats for ${vmap.size} videos`);
  await classifyFormats([...vmap.values()]);

  let refreshed = 0;
  for (const id of ids) {
    const st = state.channels[id];
    if (!profiles.has(id)) {
      if (!quotaHit) {
        // Channel no longer exists or is terminated.
        delete state.channels[id];
        channels.delete(id);
      }
      continue;
    }
    const upIds = uploads.get(id);
    if (!upIds) continue;
    const vids = upIds.map((vid) => vmap.get(vid)).filter(Boolean);
    if (quotaHit && vids.length < upIds.length * 0.8) continue;
    const { record, candidates } = computeChannel(profiles.get(id), vids, st);
    channels.set(id, record);
    st.lastFetched = today;
    for (const [vid, v] of videoPool) if (v.channelId === id) videoPool.delete(vid);
    for (const v of candidates) videoPool.set(v.id, v);
    refreshed++;
  }
  log(`refresh: ${refreshed}/${ids.length} channels updated${quotaHit ? ' (stopped early by quota budget)' : ''}`);
}

// ---------- stage 3: derived data ----------
function pruneChannels() {
  for (const [id, st] of Object.entries(state.channels)) {
    const rec = channels.get(id);
    const stale = daysBetween(Date.parse(st.lastSeen), now) > 30;
    if (isRejected(id) || (rec && rec.recentVideoCount === 0 && stale)) {
      delete state.channels[id];
      channels.delete(id);
    }
  }
  for (const id of [...channels.keys()]) if (!state.channels[id]) channels.delete(id);
  for (const [id, v] of videoPool) {
    if (!channels.has(v.channelId) || ageDays(v.publishedAt) > settings.windowDays) videoPool.delete(id);
  }
}

function pickVideos() {
  const keep = new Set();
  for (const niche of niches) {
    const cands = [...videoPool.values()]
      .filter((v) => channels.get(v.channelId)?.nicheIds.includes(niche.id))
      .sort((a, b) => b.outlier - a.outlier || b.views - a.views)
      .slice(0, settings.topVideosPerNiche);
    for (const v of cands) keep.add(v.id);
  }
  for (const id of [...videoPool.keys()]) if (!keep.has(id)) videoPool.delete(id);
}

function nicheMetrics(niche) {
  const active = [...channels.values()].filter((c) => c.nicheIds.includes(niche.id) && c.recentVideoCount > 0);
  const n = active.length;
  const empty = {
    channels: n, opportunity: null, breakoutRate: null, medianTopOutlier: null, smallChannelShare: null,
    bigChannelShare: null, newcomerRate: null, uploadsPerWeek: null, shortsShare: null, confidence: 'none',
  };
  if (n < 3) return { ...empty, confidence: n ? 'low' : 'none' };

  const withBase = active.filter((c) => c.bestOutlier60d !== null);
  const breakoutRate = withBase.length
    ? withBase.filter((c) => c.bestOutlier60d >= settings.breakoutThreshold).length / withBase.length
    : null;
  const known = active.filter((c) => c.subs !== null);
  const share = (pred) => (known.length ? known.filter(pred).length / known.length : null);
  const smallChannelShare = share((c) => c.subs < 100_000);
  const bigChannelShare = share((c) => c.subs >= 1_000_000);
  const fresh = active.filter((c) => c.createdAt && ageDays(c.createdAt) < 365);
  const newcomerRate = fresh.length ? fresh.filter((c) => c.bestViews90d >= 50_000).length / fresh.length : null;

  const rpm = niche.rpm && niche.rpm.low != null && niche.rpm.high != null ? (niche.rpm.low + niche.rpm.high) / 2 : null;
  // Opportunity score (0-100), documented on the Method page:
  //   40 breakout rate + 25 newcomer wins + 20 RPM (neutral 10 if unknown) + 15 low big-channel share
  const parts =
    (breakoutRate === null ? 0 : clamp(breakoutRate / 0.5, 0, 1) * 40) +
    (newcomerRate === null ? 0 : clamp(newcomerRate / 0.5, 0, 1) * 25) +
    (rpm === null ? 10 : clamp((rpm - 3) / 17, 0, 1) * 20) +
    (bigChannelShare === null ? 7.5 : (1 - bigChannelShare) * 15);

  return {
    channels: n,
    opportunity: Math.round(parts),
    breakoutRate: round(breakoutRate, 2),
    medianTopOutlier: round(median(withBase.map((c) => c.bestOutlier60d)), 1),
    smallChannelShare: round(smallChannelShare, 2),
    bigChannelShare: round(bigChannelShare, 2),
    newcomerRate: round(newcomerRate, 2),
    uploadsPerWeek: round(median(active.map((c) => c.uploadsPerWeek)), 1),
    shortsShare: round(mean(active.map((c) => c.shortsShare)), 2),
    confidence: n >= 15 ? 'high' : n >= 8 ? 'medium' : 'low',
  };
}

function buildFeed(finalVideos) {
  const feed = new Map(prevFeed.map((e) => [`${e.type}:${e.videoId || e.nicheId || e.id}`, e]));
  const hadNiches = prevNiches.length > 0;
  const prevIds = new Set(prevNiches.map((n) => n.id));
  if (hadNiches) {
    for (const n of niches) {
      if (prevIds.has(n.id)) continue;
      feed.set(`new_niche:${n.id}`, {
        date: today, type: 'new_niche', nicheId: n.id, title: `New niche tracked: ${n.name}`, text: n.description,
      });
    }
  }
  const fresh = finalVideos
    .filter((v) => !prevVideoIds.has(v.id) && v.outlier >= 10 && ageDays(v.publishedAt) <= 14)
    .sort((a, b) => b.outlier - a.outlier)
    .slice(0, 5);
  for (const v of fresh) {
    const ch = channels.get(v.channelId);
    feed.set(`breakout:${v.id}`, {
      date: today, type: 'breakout', videoId: v.id, channelId: v.channelId, nicheId: ch?.nicheIds[0] || null,
      title: v.title, text: `${v.outlier}x the channel's typical views`,
    });
  }
  const cutoff = now - settings.feedKeepDays * DAY_MS;
  return [...feed.values()]
    .filter((e) => Date.parse(e.date) >= cutoff)
    .sort((a, b) => b.date.localeCompare(a.date));
}

function writeHistory(nicheRows) {
  const dir = path.join(DATA, 'history');
  const snapshot = { date: today, niches: {} };
  for (const n of nicheRows) {
    snapshot.niches[n.id] = {
      opportunity: n.metrics.opportunity, breakoutRate: n.metrics.breakoutRate,
      channels: n.metrics.channels, medianTopOutlier: n.metrics.medianTopOutlier,
    };
  }
  if (nicheRows.some((n) => n.metrics.channels > 0)) writeJson(path.join(dir, `${today}.json`), snapshot);
  if (fs.existsSync(dir)) {
    const cutoff = now - settings.historyKeepDays * DAY_MS;
    for (const f of fs.readdirSync(dir)) {
      const d = Date.parse(f.replace('.json', ''));
      if (Number.isFinite(d) && d < cutoff) fs.unlinkSync(path.join(dir, f));
    }
  }
}

// ---------- main ----------
async function main() {
  let yt = null;
  if (!OFFLINE) {
    const key = process.env.YOUTUBE_API_KEY;
    if (!key) {
      console.error('YOUTUBE_API_KEY is not set. Add it as a repository secret (see README) or run with --offline.');
      process.exit(1);
    }
    yt = new YouTube({ key, budget: settings.quotaBudget });
    try {
      await discover(yt);
    } catch (err) {
      if (!(err instanceof QuotaError)) throw err;
      warn(err.message);
    }
    try {
      await refresh(yt);
    } catch (err) {
      if (!(err instanceof QuotaError)) throw err;
      warn(err.message);
    }
  }

  pruneChannels();
  pickVideos();
  const finalVideos = [...videoPool.values()].sort((a, b) => a.id.localeCompare(b.id));
  const prevById = new Map(prevNiches.map((n) => [n.id, n]));

  const nicheRows = niches.map((n) => ({
    id: n.id,
    name: n.name,
    group: n.group || 'Other',
    description: n.description || '',
    rpm: n.rpm || null,
    firstSeen: prevById.get(n.id)?.firstSeen || today,
    metrics: nicheMetrics(n),
    topVideoIds: finalVideos
      .filter((v) => channels.get(v.channelId)?.nicheIds.includes(n.id))
      .sort((a, b) => b.outlier - a.outlier)
      .slice(0, 12)
      .map((v) => v.id),
  }));

  const channelRows = [...channels.values()].sort((a, b) => a.id.localeCompare(b.id));
  const feed = OFFLINE ? prevFeed : buildFeed(finalVideos);

  // Bound the Shorts classification cache (oldest entries go first).
  const formatKeys = Object.keys(state.formats);
  for (const id of formatKeys.slice(0, Math.max(0, formatKeys.length - 30_000))) delete state.formats[id];

  writeJson(path.join(DATA, 'niches.json'), nicheRows);
  writeJsonRows(path.join(DATA, 'channels.json'), channelRows);
  writeJsonRows(path.join(DATA, 'videos.json'), finalVideos);
  writeJson(path.join(DATA, 'feed.json'), feed);
  const prevMeta = readJson(path.join(DATA, 'meta.json'), {});
  writeJson(path.join(DATA, 'meta.json'), {
    schema: 1,
    siteName: settings.siteName,
    updatedAt: OFFLINE ? prevMeta.updatedAt || null : new Date(now).toISOString(),
    breakoutThreshold: settings.breakoutThreshold,
    windowDays: settings.windowDays,
    quota: yt ? { used: yt.used, budget: settings.quotaBudget, calls: yt.calls } : prevMeta.quota || null,
    counts: {
      niches: nicheRows.length,
      channels: channelRows.length,
      videos: finalVideos.length,
      reviewedChannels: channelRows.filter((c) => reviews.channels?.[c.id]?.faceless === true).length,
    },
  });
  if (!OFFLINE) writeHistory(nicheRows);
  writeJson(STATE_FILE, state);

  log(
    `done: ${nicheRows.length} niches, ${channelRows.length} channels, ${finalVideos.length} videos` +
      (yt ? `, quota used ${yt.used}/${settings.quotaBudget}` : ' (offline)'),
  );
}

main().catch((err) => {
  console.error(`[collect] failed: ${err.message}`);
  process.exit(1);
});
