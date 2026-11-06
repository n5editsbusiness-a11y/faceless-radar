// Minimal YouTube Data API v3 client with quota accounting.
// Costs follow https://developers.google.com/youtube/v3/determine_quota_cost
// (search.list = 100 units, every list call used here = 1 unit).

export class QuotaError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COST = { search: 100, channels: 1, playlistItems: 1, videos: 1 };

export class YouTube {
  constructor({ key, budget = 9000, base } = {}) {
    this.key = key;
    this.budget = budget;
    this.base = base || process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
    this.used = 0;
    this.calls = {};
  }

  async request(method, params) {
    const cost = COST[method] ?? 1;
    if (this.used + cost > this.budget) {
      throw new QuotaError(`Quota budget of ${this.budget} units reached before ${method}`);
    }
    const url = new URL(`${this.base}/${method}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
    url.searchParams.set('key', this.key);

    for (let attempt = 0; attempt < 4; attempt++) {
      let res;
      try {
        res = await fetch(url, { headers: { accept: 'application/json' } });
      } catch {
        if (attempt === 3) throw new Error(`YouTube API ${method}: network error`);
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.ok) {
        this.used += cost;
        this.calls[method] = (this.calls[method] || 0) + 1;
        return res.json();
      }
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || '';
      if (res.status === 403 && /quota|rateLimit/i.test(reason)) {
        throw new QuotaError(`YouTube API quota exceeded during ${method} (${reason})`);
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      const err = new Error(`YouTube API ${method} failed: HTTP ${res.status} ${reason}`.trim());
      err.status = res.status;
      err.reason = reason;
      throw err;
    }
  }

  search(params) {
    return this.request('search', params);
  }
  channels(ids) {
    return this.request('channels', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
  }
  playlistItems(playlistId) {
    return this.request('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50 });
  }
  videos(ids) {
    return this.request('videos', { part: 'snippet,statistics,contentDetails', id: ids.join(','), maxResults: 50 });
  }
}
