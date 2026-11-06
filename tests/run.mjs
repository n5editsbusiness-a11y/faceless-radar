// End-to-end test of the collector against a synthetic YouTube API. Run with: npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startMock, CHANNELS } from './mock-yt-server.mjs';
import { median } from '../scripts/lib/stats.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// Async on purpose: the mock API lives in this process, so a blocking spawn would deadlock it.
function runCollect(env, extra = []) {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(ROOT, 'scripts', 'collect.mjs'), ...extra], {
      env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

const checks = [];
const ok = (name) => {
  checks.push(name);
  console.log(`  ok  ${name}`);
};

const mock = await startMock();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-test-'));
const data = path.join(tmp, 'data');
const stateDir = path.join(tmp, 'state');
const env = {
  DATA_DIR: data, STATE_DIR: stateDir, YOUTUBE_API_KEY: 'test-key-123',
  YT_API_BASE: mock.url, SHORTS_CHECK_BASE: `${mock.url}/shorts/`,
};
const settings = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'settings.json'), 'utf8'));

try {
  // 1. first run
  let r = await runCollect(env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!r.stdout.includes('test-key-123') && !r.stderr.includes('test-key-123'), 'API key must not be logged');
  const niches = read(data, 'niches.json');
  const channels = read(data, 'channels.json');
  const videos = read(data, 'videos.json');
  const meta = read(data, 'meta.json');
  assert.equal(niches.length, JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'niches.json'), 'utf8')).length);
  assert.ok(channels.length > 20, `expected >20 channels, got ${channels.length}`);
  assert.ok(videos.length > 20, `expected >20 videos, got ${videos.length}`);
  ok(`first run wrote ${niches.length} niches, ${channels.length} channels, ${videos.length} videos`);

  // 2. quota accounting: 40 searches x 100 units + cheap reads, under the budget
  assert.equal(mock.seen.search, settings.maxSearchesPerRun);
  assert.equal(meta.quota.used, mock.seen.search * 100 + mock.seen.channels + mock.seen.playlistItems + mock.seen.videos);
  assert.ok(meta.quota.used <= settings.quotaBudget);
  ok(`quota accounting matches (${meta.quota.used} of ${settings.quotaBudget} units)`);
  assert.deepEqual([...mock.seen.keys], ['test-key-123']);

  // 3. outlier scores recomputed independently from the synthetic source
  const dayMs = 86_400_000;
  let checked = 0;
  for (const v of videos) {
    const src = CHANNELS.find((c) => c.id === v.channelId);
    const mv = src.videos.find((x) => x.id === v.id);
    const sameFormat = src.videos
      .filter((x) => (x.duration <= 60 ? 'short' : 'long') === v.format)
      .filter((x) => (Date.now() - Date.parse(x.publishedAt)) / dayMs >= settings.minVideoAgeDays)
      .slice(0, settings.baselineVideos);
    const base = median(sameFormat.map((x) => x.views));
    assert.equal(v.baseline, base, `baseline mismatch for ${v.id}`);
    assert.equal(v.outlier, Math.round((mv.views / base) * 10) / 10, `outlier mismatch for ${v.id}`);
    assert.equal(v.format, src.shorty ? 'short' : 'long', `format mismatch for ${v.id}`);
    checked++;
  }
  ok(`outlier score, baseline and Shorts detection verified for ${checked} videos`);

  // 4. hidden subscriber counts stay null instead of 0
  const hidden = channels.filter((c) => CHANNELS.find((m) => m.id === c.id).hidden);
  assert.ok(hidden.length > 0 && hidden.every((c) => c.subs === null));
  ok(`hidden subscriber counts stored as null (${hidden.length} channels)`);

  // 5. niche metrics are sane
  const scored = niches.filter((n) => n.metrics.opportunity !== null);
  assert.ok(scored.length > 5);
  for (const n of scored) {
    assert.ok(n.metrics.opportunity >= 0 && n.metrics.opportunity <= 100, `${n.id} opportunity out of range`);
    for (const k of ['breakoutRate', 'smallChannelShare', 'bigChannelShare']) {
      const x = n.metrics[k];
      assert.ok(x === null || (x >= 0 && x <= 1), `${n.id}.${k}=${x}`);
    }
  }
  ok(`${scored.length} niches scored, all metrics in range`);

  // 6. second run rotates to the stalest searches and stays consistent
  const searchesBefore = mock.seen.search;
  r = await runCollect(env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(mock.seen.search - searchesBefore, settings.maxSearchesPerRun);
  const state = read(stateDir, 'state.json');
  const ran = Object.values(state.queries).length;
  assert.ok(ran > settings.maxSearchesPerRun, `second run should cover new niche/format pairs, got ${ran}`);
  ok(`second run rotated to new searches (${ran} niche/format pairs covered)`);

  // 7. reviewed-out channels disappear and stay out
  const victim = read(data, 'channels.json')[0].id;
  fs.writeFileSync(path.join(data, 'reviews.json'), JSON.stringify({ channels: { [victim]: { faceless: false } }, videos: {} }));
  r = await runCollect(env);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(!read(data, 'channels.json').some((c) => c.id === victim));
  assert.ok(!read(data, 'videos.json').some((v) => v.channelId === victim));
  ok('channel marked not-faceless is removed from channels and videos');

  // 8. quota ceiling: stops gracefully and still writes output
  const mock2 = await startMock({ quotaAfter: 6 });
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-test-q-'));
  r = await runCollect({
    ...env, DATA_DIR: path.join(tmp2, 'data'), STATE_DIR: path.join(tmp2, 's'),
    YT_API_BASE: mock2.url, SHORTS_CHECK_BASE: `${mock2.url}/shorts/`,
  });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stderr, /quota/i);
  assert.ok(fs.existsSync(path.join(tmp2, 'data', 'niches.json')));
  await mock2.close();
  fs.rmSync(tmp2, { recursive: true, force: true });
  ok('API quota error ends the run gracefully with output written');

  // 9. missing key fails with a clear message
  r = await runCollect({ ...env, YOUTUBE_API_KEY: '' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /YOUTUBE_API_KEY/);
  ok('missing API key exits with a clear error');

  // 10. offline rebuild keeps existing data
  const before = read(data, 'channels.json').length;
  r = await runCollect(env, ['--offline']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(data, 'channels.json').length, before);
  ok('--offline rebuild keeps existing data');

  console.log(`\nPASS ${checks.length} checks. Test data kept at ${data} for preview (synthetic, not shipped).`);
} catch (err) {
  console.error(`\nFAIL: ${err.message}`);
  process.exitCode = 1;
} finally {
  await mock.close();
}
