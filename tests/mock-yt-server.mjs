// A tiny fake of the YouTube Data API used ONLY by tests and local previews.
// Every channel and video it serves is synthetic ("Mock Channel 12"); none of it is shipped as site data.
import http from 'node:http';

function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = 86_400_000;
const NOW = Date.now();
const N_CHANNELS = 160;

export const CHANNELS = Array.from({ length: N_CHANNELS }, (_, i) => {
  const r = rng(i + 1);
  const shorty = i % 3 === 0;
  const subs = Math.round(10 ** (3 + r() * 3.3));
  const ageDays = 30 + Math.floor(r() * 1500);
  const base = Math.round(subs * (0.02 + r() * 0.15)) + 500;
  const outlierAt = r() < 0.3 ? 3 + Math.floor(r() * 8) : -1;
  const mult = 6 + Math.floor(r() * 35);
  const videos = Array.from({ length: 40 }, (_, k) => {
    const publishedAt = new Date(NOW - (k * 2.4 + 1) * DAY).toISOString();
    const duration = shorty ? 28 + Math.floor(r() * 30) : 420 + Math.floor(r() * 900);
    const views = Math.round(base * (0.5 + r()) * (k === outlierAt ? mult : 1));
    return {
      id: `mock${String(i).padStart(3, '0')}v${String(k).padStart(2, '0')}`,
      channelId: `UCmock${String(i).padStart(4, '0')}`,
      title: `Mock video ${i}-${k}`,
      publishedAt,
      duration,
      views,
    };
  });
  return {
    id: `UCmock${String(i).padStart(4, '0')}`,
    uploads: `UUmock${String(i).padStart(4, '0')}`,
    title: `Mock Channel ${i}`,
    createdAt: new Date(NOW - ageDays * DAY).toISOString(),
    subs,
    hidden: i % 17 === 0,
    shorty,
    videos,
  };
});

const byId = new Map(CHANNELS.map((c) => [c.id, c]));
const byUploads = new Map(CHANNELS.map((c) => [c.uploads, c]));
const videoById = new Map(CHANNELS.flatMap((c) => c.videos.map((v) => [v.id, v])));

const iso = (sec) => `PT${Math.floor(sec / 60)}M${sec % 60}S`;
const hash = (s) => [...s].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);

export function startMock({ quotaAfter = Infinity } = {}) {
  let calls = 0;
  const seen = { search: 0, channels: 0, playlistItems: 0, videos: 0, shorts: 0, keys: new Set() };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (code, body, headers = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/shorts/')) {
      seen.shorts++;
      const v = videoById.get(url.pathname.slice(8));
      if (v && v.duration <= 60) return send(200, {});
      return send(303, {}, { location: 'https://example.invalid/watch' });
    }
    const method = url.pathname.replace(/^\/+/, '');
    seen.keys.add(url.searchParams.get('key'));
    if (!(method in seen)) return send(404, { error: { message: 'unknown method' } });
    calls++;
    if (calls > quotaAfter) {
      return send(403, { error: { errors: [{ reason: 'quotaExceeded' }], message: 'quota' } });
    }
    seen[method]++;
    const p = url.searchParams;
    if (method === 'search') {
      const start = Math.abs(hash(`${p.get('q')}|${p.get('videoDuration')}`)) % N_CHANNELS;
      const items = [];
      for (let k = 0; k < 40; k++) {
        const c = CHANNELS[(start + k * 3) % N_CHANNELS];
        if (c.shorty !== (p.get('videoDuration') === 'short')) continue;
        items.push({ id: { videoId: c.videos[1].id }, snippet: { channelId: c.id } });
      }
      return send(200, { items });
    }
    if (method === 'channels') {
      const items = p
        .get('id')
        .split(',')
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((c) => ({
          id: c.id,
          snippet: { title: c.title, customUrl: `@${c.id}`, publishedAt: c.createdAt, thumbnails: { default: { url: 'https://example.invalid/a.jpg' } } },
          statistics: { subscriberCount: String(c.subs), hiddenSubscriberCount: c.hidden, viewCount: String(c.subs * 40), videoCount: '40' },
          contentDetails: { relatedPlaylists: { uploads: c.uploads } },
        }));
      return send(200, { items });
    }
    if (method === 'playlistItems') {
      const c = byUploads.get(p.get('playlistId'));
      if (!c) return send(404, { error: { errors: [{ reason: 'playlistNotFound' }] } });
      const items = c.videos.slice(0, 50).map((v) => ({ contentDetails: { videoId: v.id, videoPublishedAt: v.publishedAt } }));
      return send(200, { items });
    }
    if (method === 'videos') {
      const items = p
        .get('id')
        .split(',')
        .map((id) => videoById.get(id))
        .filter(Boolean)
        .map((v) => ({
          id: v.id,
          snippet: { channelId: v.channelId, title: v.title, publishedAt: v.publishedAt, liveBroadcastContent: 'none' },
          contentDetails: { duration: iso(v.duration) },
          statistics: { viewCount: String(v.views) },
        }));
      return send(200, { items });
    }
    return send(400, {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(r)) });
    });
  });
}
