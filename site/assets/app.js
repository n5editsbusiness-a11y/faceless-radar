// Faceless Radar front end. No build step, no dependencies.
// All text that comes from data files is escaped before it touches innerHTML.

const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeId = (s) => (/^[A-Za-z0-9_-]{3,64}$/.test(s || '') ? s : null);
const DAY = 86_400_000;
const ytVideo = (id) => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;
const ytChannel = (id) => `https://www.youtube.com/channel/${encodeURIComponent(id)}`;
const thumbUrl = (id) => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;

/* ---------- formatting ---------- */
const fmtNum = (n) => {
  if (n === null || n === undefined) return 'hidden';
  const t = (x, d) => x.toFixed(d).replace(/\.0$/, '');
  if (n >= 1e9) return `${t(n / 1e9, 1)}B`;
  if (n >= 1e6) return `${t(n / 1e6, n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${t(n / 1e3, n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
};
const fmtX = (x) => (x === null || x === undefined ? '–' : `${x >= 10 ? Math.round(x) : x.toFixed(1)}×`);
const fmtPct = (x) => (x === null || x === undefined ? '–' : `${Math.round(x * 100)}%`);
const ageDays = (iso) => (Date.now() - Date.parse(iso)) / DAY;
const ago = (iso) => {
  if (!iso) return 'never';
  const h = (Date.now() - Date.parse(iso)) / 3_600_000;
  if (h < 1) return 'just now';
  if (h < 24) return `${Math.round(h)} hours ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
};
const dayLabel = (iso) => new Date(`${iso}T12:00:00Z`).toLocaleDateString('en', { month: 'short', day: 'numeric' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* ---------- data ---------- */
const D = {};
const settings = { verifiedOnly: false };
try {
  settings.verifiedOnly = localStorage.getItem('fr.verified') === '1';
} catch {
  /* storage can be unavailable; the filter simply resets on reload */
}

async function load() {
  const get = async (name, fallback) => {
    try {
      const res = await fetch(`data/${name}.json`, { cache: 'no-cache' });
      return res.ok ? await res.json() : fallback;
    } catch {
      return fallback;
    }
  };
  const [meta, niches, channels, videos, feed, reviews, notes, analysis] = await Promise.all([
    get('meta', null), get('niches', null), get('channels', []), get('videos', []), get('feed', []),
    get('reviews', { channels: {}, videos: {} }), get('niche_notes', {}), get('analysis', null),
  ]);
  if (!niches) throw new Error('Data files not found. Serve the site over http (npm run serve) instead of opening the file.');
  Object.assign(D, { meta: meta || {}, niches, channels, videos, feed, reviews, notes, analysis });
  D.nicheById = new Map(niches.map((n) => [n.id, n]));
  D.channelById = new Map(channels.map((c) => [c.id, c]));
  D.videoById = new Map(videos.map((v) => [v.id, v]));
}

const verdict = (channelId) => D.reviews.channels?.[channelId]?.faceless; // true, false or undefined
const channelVisible = (c) => c && verdict(c.id) !== false && (!settings.verifiedOnly || verdict(c.id) === true);
const visibleChannels = () => D.channels.filter(channelVisible);
const visibleVideos = () => D.videos.filter((v) => channelVisible(D.channelById.get(v.channelId)));
const hasData = () => D.videos.length > 0;
const verifiedCount = () => Object.values(D.reviews.channels || {}).filter((r) => r.faceless === true).length;

/* ---------- small components ---------- */
const checkIcon = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function faceBadge(channelId) {
  return verdict(channelId) === true ? `<span class="ok">${checkIcon}Verified faceless</span>` : '';
}
function badgeOrPending(channelId) {
  return verdict(channelId) === true ? faceBadge(channelId) : '<span>Not reviewed yet</span>';
}

function meter(value, max = 100, tip = '') {
  if (value === null || value === undefined) return '<span class="muted">–</span>';
  return `<span class="meter" data-tip="${esc(tip)}"><span class="track"><i style="width:${Math.max(2, (value / max) * 100)}%"></i></span><b>${value}</b></span>`;
}

function rpmRange(rpm) {
  if (!rpm) return '<span class="muted small rpm-none">no public estimate</span>';
  if (rpm.low === null || rpm.low === undefined) {
    return rpm.tier ? `<span class="muted small rpm-none">${esc(rpm.tier)}, no figure</span>` : '<span class="muted small rpm-none">no public estimate</span>';
  }
  const max = 30;
  const left = (rpm.low / max) * 100;
  const width = Math.max(3, (Math.min(rpm.high, max) - rpm.low) / max * 100);
  const tip = `Third-party estimate: $${rpm.low} to $${rpm.high} per 1,000 views. Scale runs from $0 to $${max}.`;
  return `<span class="range" data-tip="${esc(tip)}"><span class="track"><i style="left:${left}%;width:${width}%"></i></span><span>$${rpm.low} to ${rpm.high}</span></span>`;
}

function nicheOf(channel) {
  return channel ? D.nicheById.get(channel.nicheIds[0]) : null;
}

function baseBar(v) {
  const pct = v.baseline && v.views ? Math.min(100, Math.max(1, (v.baseline / v.views) * 100)) : 0;
  const tip = `This video: ${fmtNum(v.views)} views. The channel's typical ${v.format === 'short' ? 'Short' : 'video'}: ${fmtNum(v.baseline)}.`;
  return `<div class="base" data-tip="${esc(tip)}" aria-hidden="true"><i></i><b style="left:${pct}%"></b></div>`;
}

function thumbBlock(v) {
  const id = safeId(v.id);
  if (!id) return '';
  return `<a class="tthumb" href="${ytVideo(id)}" target="_blank" rel="noopener noreferrer" aria-label="Watch on YouTube: ${esc(v.title)}">
    <img src="${thumbUrl(id)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">
    <span class="mult">${fmtX(v.outlier)}</span>${v.format === 'short' ? '<span class="fmt">Short</span>' : ''}</a>`;
}

function signalCard(v) {
  const ch = D.channelById.get(v.channelId);
  const niche = nicheOf(ch);
  return `<article class="sig">${thumbBlock(v)}
    <h3 class="ttitle">${esc(v.title)}</h3>
    <div class="tmeta"><a href="#/channel/${esc(v.channelId)}">${esc(ch?.title)}</a>${niche ? `<a href="#/niche/${esc(niche.id)}">${esc(niche.name)}</a>` : ''}</div>
    ${baseBar(v)}
    <p class="tcap">${fmtNum(v.views)} views against ${fmtNum(v.baseline)} typical, ${Math.round(ageDays(v.publishedAt))} days old</p></article>`;
}

function thumbCard(v) {
  const ch = D.channelById.get(v.channelId);
  const niche = nicheOf(ch);
  const tags = (D.reviews.videos?.[v.id]?.tags || []).slice(0, 4);
  return `<article class="tcard">${thumbBlock(v)}
    <h3 class="ttitle">${esc(v.title)}</h3>
    <div class="tmeta"><a href="#/channel/${esc(v.channelId)}">${esc(ch?.title)}</a><span>${fmtNum(ch?.subs)} subscribers</span></div>
    ${baseBar(v)}
    <p class="tcap">${fmtNum(v.views)} views against ${fmtNum(v.baseline)} typical, ${Math.round(ageDays(v.publishedAt))} days old</p>
    <div class="tmeta">${niche ? `<a href="#/niche/${esc(niche.id)}">${esc(niche.name)}</a>` : ''}${faceBadge(v.channelId)}</div>
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">${esc(String(t).replace(/-/g, ' '))}</span>`).join('')}</div>` : ''}</article>`;
}

function waitingPanel() {
  return `<div class="waiting"><h2>Waiting for the first data run</h2>
    <p class="muted">The site is deployed, but no YouTube data has been collected yet. This is what to do:</p>
    <ol><li>Add your YouTube Data API key as the repository secret <code>YOUTUBE_API_KEY</code>.</li>
    <li>Open the Actions tab and run the workflow "Daily update and deploy".</li>
    <li>Reload this page when the run finishes. It repeats every day on its own.</li></ol></div>`;
}

function reviewNote() {
  if (!hasData() || settings.verifiedOnly) return '';
  const all = visibleChannels().length;
  const done = verifiedCount();
  if (done >= all) return '';
  return `<p class="review-note">${done} of ${all} tracked channels have been checked and verified as faceless. The rest are unreviewed and may include a presenter.</p>`;
}

function verifiedNote() {
  if (!settings.verifiedOnly) return '';
  return verifiedCount() === 0
    ? '<p class="muted small" style="margin-bottom:16px">No channel has been verified as faceless yet, so the filter hides everything. Turn off "Verified faceless only" to see all tracked channels.</p>'
    : '';
}

/* ---------- views ---------- */
function renderHome() {
  document.title = 'Breakouts | Faceless Radar';
  const m = D.meta;
  const nicheCount = D.niches.length;
  let html = `<header class="page-head"><h1>This week's breakouts</h1>
    <p class="lede">Videos from faceless channels that beat their own channel's typical views by the widest margin. Tracking ${plural(nicheCount, 'niche')}${hasData() ? ` and ${plural(visibleChannels().length, 'channel')}` : ''}.</p></header>`;
  if (!hasData()) {
    view.innerHTML = `${html}${waitingPanel()}<section><div class="sec-head"><h2>Niches being tracked</h2></div>${nicheListByGroup()}</section>`;
    return;
  }
  const vids = visibleVideos();
  let list = vids.filter((v) => ageDays(v.publishedAt) <= 14);
  if (list.length < 4) list = vids;
  list = list.sort((a, b) => b.outlier - a.outlier).slice(0, 10);
  html += `${verifiedNote()}${reviewNote()}<section><div class="sec-head"><h2>Biggest outliers</h2>
    <p>The bar under each thumbnail shows the video's views. The white tick marks what the channel's typical video gets.</p></div>
    <div class="signal">${list.map(signalCard).join('')}</div></section>`;

  const top = [...D.niches].filter((n) => n.metrics.opportunity !== null)
    .sort((a, b) => b.metrics.opportunity - a.metrics.opportunity).slice(0, 8);
  const feed = (D.feed || []).slice(0, 8);
  html += `<section class="two"><div><div class="sec-head"><h2>Niches with the most room</h2>
    <p>Ranked by opportunity score. <a href="#/niches">See all niches</a>, or read how the score works on the <a href="#/about">Method</a> page.</p></div>
    <div class="scroll"><table><thead><tr><th>Niche</th><th>Opportunity</th><th class="num">Breakout rate</th><th>Est. RPM</th></tr></thead><tbody>
    ${top.map((n) => `<tr><td><div class="cell-name"><a href="#/niche/${esc(n.id)}">${esc(n.name)}</a></div></td>
      <td>${meter(n.metrics.opportunity, 100, scoreTip(n))}</td><td class="num">${fmtPct(n.metrics.breakoutRate)}</td><td>${rpmRange(n.rpm)}</td></tr>`).join('')}
    </tbody></table></div></div>
    <aside><div class="sec-head"><h2>What changed</h2></div>${analysisBlock()}
    ${feed.length ? `<ul class="feed">${feed.map(feedItem).join('')}</ul>` : '<p class="muted">The feed fills up after the second daily run.</p>'}</aside></section>`;
  view.innerHTML = html;
}

function analysisBlock() {
  const a = D.analysis;
  if (!a || !a.headline) return '';
  const watch = (a.watch || []).map((id) => D.nicheById.get(id)).filter(Boolean);
  return `<div class="note" style="margin-bottom:18px"><h3>${esc(a.headline)}</h3>
    ${(a.paragraphs || []).map((p) => `<p>${esc(p)}</p>`).join('')}
    ${watch.length ? `<p class="small muted">Worth a look: ${watch.map((n) => `<a href="#/niche/${esc(n.id)}">${esc(n.name)}</a>`).join(', ')}</p>` : ''}
    <p class="small muted">Written ${esc(a.date || '')}</p></div>`;
}

function feedItem(e) {
  const link = e.type === 'breakout' && safeId(e.videoId)
    ? `<a href="${ytVideo(e.videoId)}" target="_blank" rel="noopener noreferrer">${esc(e.title)}</a>`
    : e.nicheId && D.nicheById.has(e.nicheId) ? `<a href="#/niche/${esc(e.nicheId)}">${esc(e.title)}</a>` : esc(e.title);
  return `<li><time datetime="${esc(e.date)}">${esc(dayLabel(e.date))}</time><div>${link}<p>${esc(e.text)}</p></div></li>`;
}

function nicheListByGroup() {
  const groups = new Map();
  for (const n of D.niches) groups.set(n.group, [...(groups.get(n.group) || []), n]);
  return [...groups].map(([g, items]) => `<p style="margin:14px 0 4px"><strong>${esc(g)}</strong></p>
    <p class="muted">${items.map((n) => `<a href="#/niche/${esc(n.id)}">${esc(n.name)}</a>`).join(', ')}</p>`).join('');
}

function scoreTip(n) {
  const m = n.metrics;
  return `Opportunity ${m.opportunity} of 100, from ${plural(m.channels, 'channel')} (${m.confidence} confidence).`;
}

/* niches table */
const NICHE_COLS = [
  { key: 'name', label: 'Niche', get: (n) => n.name.toLowerCase(), cls: '' },
  { key: 'opportunity', label: 'Opportunity', get: (n) => n.metrics.opportunity },
  { key: 'breakout', label: 'Breakout rate', get: (n) => n.metrics.breakoutRate, cls: 'num' },
  { key: 'outlier', label: 'Typical best outlier', get: (n) => n.metrics.medianTopOutlier, cls: 'num' },
  { key: 'channels', label: 'Channels sampled', get: (n) => n.metrics.channels, cls: 'num' },
  { key: 'small', label: 'Under 100K subs', get: (n) => n.metrics.smallChannelShare, cls: 'num' },
  { key: 'rpm', label: 'Est. RPM', get: (n) => (n.rpm && n.rpm.low != null ? (n.rpm.low + n.rpm.high) / 2 : null) },
];
const nicheSort = { key: 'opportunity', dir: -1 };

function nicheRow(n) {
  const m = n.metrics;
  return `<tr><td><div class="cell-name"><a href="#/niche/${esc(n.id)}">${esc(n.name)}</a><span class="muted small">${esc(n.group)}</span></div></td>
    <td>${meter(m.opportunity, 100, m.opportunity === null ? 'Not enough channels sampled yet.' : scoreTip(n))}</td>
    <td class="num">${fmtPct(m.breakoutRate)}</td><td class="num">${fmtX(m.medianTopOutlier)}</td>
    <td class="num ${m.confidence === 'low' ? 'conf-low' : ''}" data-tip="${esc(`Confidence: ${m.confidence}`)}">${m.channels}</td>
    <td class="num">${fmtPct(m.smallChannelShare)}</td><td>${rpmRange(n.rpm)}</td></tr>`;
}

function renderNiches() {
  document.title = 'Niches | Faceless Radar';
  const groups = [...new Set(D.niches.map((n) => n.group))];
  view.innerHTML = `<header class="page-head"><h1>Niches</h1>
    <p class="lede">Every faceless niche being tracked, with how often channels in it produce breakout videos and what the niche is estimated to pay.</p></header>
    <div class="controls"><label class="field">Search<input type="search" id="nq" placeholder="Niche name"></label>
    <label class="field">Group<select id="ng"><option value="">All groups</option>${groups.map((g) => `<option>${esc(g)}</option>`).join('')}</select></label></div>
    ${hasData() ? '' : waitingPanel()}
    <div class="scroll"><table id="ntable"><thead><tr>${NICHE_COLS.map((c) => `<th class="${c.cls || ''}" data-col="${c.key}"><button type="button">${esc(c.label)}</button></th>`).join('')}</tr></thead><tbody></tbody></table></div>
    <p class="muted small" style="margin-top:14px;max-width:70ch">RPM figures are estimates collected from third-party articles and vary a lot between sources, so treat them as a range, not a promise. Hover or open a niche to see the sources. The bar scale runs from $0 to $30.</p>`;
  const body = $('#ntable tbody');
  const draw = () => {
    const q = $('#nq').value.trim().toLowerCase();
    const g = $('#ng').value;
    const col = NICHE_COLS.find((c) => c.key === nicheSort.key);
    const rows = D.niches.filter((n) => (!g || n.group === g) && (!q || n.name.toLowerCase().includes(q)))
      .sort((a, b) => {
        const x = col.get(a); const y = col.get(b);
        if (x === null || x === undefined) return y === null || y === undefined ? 0 : 1;
        if (y === null || y === undefined) return -1;
        return (x < y ? -1 : x > y ? 1 : 0) * nicheSort.dir;
      });
    body.innerHTML = rows.map(nicheRow).join('') || '<tr><td colspan="7" class="muted">No niche matches that search.</td></tr>';
    for (const th of $$('#ntable th')) {
      if (th.dataset.col === nicheSort.key) th.setAttribute('aria-sort', nicheSort.dir === 1 ? 'ascending' : 'descending');
      else th.removeAttribute('aria-sort');
    }
  };
  $('#ntable thead').addEventListener('click', (e) => {
    const th = e.target.closest('th');
    if (!th) return;
    const key = th.dataset.col;
    if (nicheSort.key === key) nicheSort.dir *= -1;
    else { nicheSort.key = key; nicheSort.dir = key === 'name' ? 1 : -1; }
    draw();
  });
  $('#nq').addEventListener('input', draw);
  $('#ng').addEventListener('change', draw);
  draw();
}
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

function renderNiche(id) {
  const n = D.nicheById.get(id);
  if (!n) return notFound('That niche is not tracked.');
  document.title = `${n.name} | Faceless Radar`;
  const m = n.metrics;
  const note = D.notes?.[id];
  const chans = visibleChannels().filter((c) => c.nicheIds.includes(id))
    .sort((a, b) => (b.bestOutlier60d ?? -1) - (a.bestOutlier60d ?? -1));
  const vids = visibleVideos().filter((v) => D.channelById.get(v.channelId).nicheIds.includes(id))
    .sort((a, b) => b.outlier - a.outlier);
  const sources = (n.rpm?.sources || []).map((s) => /^https:\/\//.test(s.url) ? `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.label)}</a>` : esc(s.label)).join(', ');
  view.innerHTML = `<a class="back" href="#/niches">Back to all niches</a>
    <header class="page-head" style="margin-top:10px"><h1>${esc(n.name)}</h1><p class="lede">${esc(n.description)}</p></header>
    <dl class="facts">
      <div><dt>Opportunity score</dt><dd>${m.opportunity ?? '–'}<small>${m.confidence === 'none' ? 'No channels sampled yet' : `${plural(m.channels, 'channel')} sampled, ${m.confidence} confidence`}</small></dd></div>
      <div><dt>Breakout rate</dt><dd>${fmtPct(m.breakoutRate)}<small>channels with a ${D.meta.breakoutThreshold ?? 5}× video (${fmtNum(D.meta.breakoutMinViews ?? 0)}+ views) in 60 days</small></dd></div>
      <div><dt>Typical best outlier</dt><dd>${fmtX(m.medianTopOutlier)}<small>median across channels</small></dd></div>
      <div><dt>Small channels</dt><dd>${fmtPct(m.smallChannelShare)}<small>under 100K subscribers</small></dd></div>
      <div><dt>Upload pace</dt><dd>${m.uploadsPerWeek ?? '–'}<small>videos per week, median</small></dd></div>
      <div><dt>Shorts share</dt><dd>${fmtPct(m.shortsShare)}<small>of recent uploads</small></dd></div>
    </dl>
    <section><div class="sec-head"><h2>Estimated earnings</h2></div>
      <p>${rpmRange(n.rpm)}</p>
      <p class="muted small" style="margin-top:8px;max-width:70ch">${n.rpm?.note ? `${esc(n.rpm.note)} ` : ''}${sources ? `Sources: ${sources}.` : 'No public per-niche estimate was found.'} RPM is what a creator earns per 1,000 views and depends heavily on audience country and season.</p></section>
    <section><div class="sec-head"><h2>Thumbnail formula</h2></div>${formulaBlock(note)}</section>
    <section><div class="sec-head"><h2>Top thumbnails</h2><p>Highest outlier scores in this niche. <a href="#/thumbnails?niche=${esc(id)}">Open them in the gallery</a>.</p></div>
      ${verifiedNote()}${reviewNote()}${vids.length ? `<div class="tgrid">${vids.slice(0, 8).map(thumbCard).join('')}</div>` : '<p class="muted">No videos collected for this niche yet.</p>'}</section>
    <section><div class="sec-head"><h2>Channels</h2></div>${channelTable(chans)}</section>`;
}

function formulaBlock(note) {
  if (!note || (!note.summary && !(note.thumbnailFormula || []).length)) {
    return '<p class="muted" style="max-width:70ch">Not analyzed yet. The daily review looks at the top thumbnails of each niche and writes the common pattern here.</p>';
  }
  const list = (items) => (items?.length ? `<ul class="formula">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '');
  return `${note.summary ? `<p style="max-width:70ch;margin-bottom:12px">${esc(note.summary)}</p>` : ''}${list(note.thumbnailFormula)}
    ${note.titlePatterns?.length ? `<h3 style="margin:18px 0 8px">Title patterns</h3>${list(note.titlePatterns)}` : ''}
    ${note.updatedOn ? `<p class="muted small" style="margin-top:10px">Reviewed ${esc(note.updatedOn)}</p>` : ''}`;
}

function channelTable(chans) {
  if (!chans.length) return '<p class="muted">No channels to show.</p>';
  return `<div class="scroll"><table><thead><tr><th>Channel</th><th class="num">Subscribers</th><th class="num">Best outlier</th><th class="num">Uploads per week</th><th class="num">Shorts share</th><th>Faceless</th></tr></thead><tbody>
    ${chans.slice(0, 40).map((c) => `<tr><td><div class="cell-ch">${avatar(c)}<a href="#/channel/${esc(c.id)}">${esc(c.title)}</a></div></td>
      <td class="num">${fmtNum(c.subs)}</td><td class="num">${fmtX(c.bestOutlier60d)}</td><td class="num">${c.uploadsPerWeek ?? '–'}</td>
      <td class="num">${fmtPct(c.shortsShare)}</td><td>${badgeOrPending(c.id)}</td></tr>`).join('')}</tbody></table></div>`;
}

function avatar(c) {
  return c.avatar && /^https:\/\//.test(c.avatar)
    ? `<img class="avatar" src="${esc(c.avatar)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="avatar"></span>';
}

/* thumbnails gallery */
function renderThumbs(_, params) {
  document.title = 'Thumbnails | Faceless Radar';
  const f = {
    niche: params.get('niche') || '', format: params.get('format') || 'all', min: Number(params.get('min') ?? 3),
    sort: params.get('sort') || 'outlier', q: params.get('q') || '',
  };
  let shown = 48;
  const nicheOpts = [...D.niches].sort((a, b) => a.name.localeCompare(b.name))
    .map((n) => `<option value="${esc(n.id)}" ${n.id === f.niche ? 'selected' : ''}>${esc(n.name)}</option>`).join('');
  const sel = (val, opts) => opts.map(([v, l]) => `<option value="${v}" ${String(v) === String(val) ? 'selected' : ''}>${l}</option>`).join('');
  view.innerHTML = `<header class="page-head"><h1>Thumbnails</h1>
    <p class="lede">Browse the thumbnails behind breakout videos. Filter by niche, format and how far a video beat its channel's typical views.</p></header>
    <div class="controls">
      <label class="field">Niche<select id="fn"><option value="">All niches</option>${nicheOpts}</select></label>
      <div class="field">Format<div class="seg" role="group" aria-label="Format">
        ${[['all', 'All'], ['long', 'Long'], ['short', 'Shorts']].map(([v, l]) => `<button type="button" data-format="${v}" aria-pressed="${f.format === v}">${l}</button>`).join('')}</div></div>
      <label class="field">Minimum outlier<select id="fm">${sel(f.min, [[1, 'Any'], [3, '3× or more'], [5, '5× or more'], [10, '10× or more'], [20, '20× or more']])}</select></label>
      <label class="field">Sort by<select id="fs">${sel(f.sort, [['outlier', 'Outlier score'], ['views', 'Total views'], ['vpd', 'Views per day'], ['recent', 'Newest']])}</select></label>
      <label class="field">Title contains<input type="search" id="fq" value="${esc(f.q)}" placeholder="Search titles"></label>
    </div>${hasData() ? verifiedNote() + reviewNote() : waitingPanel()}
    <p class="muted small" id="count" style="margin-bottom:16px" aria-live="polite"></p>
    <div class="tgrid" id="grid"></div><div class="more" id="more"></div>`;
  const grid = $('#grid');
  const draw = (reset = true) => {
    if (reset) shown = 48;
    const q = f.q.trim().toLowerCase();
    const sorters = {
      outlier: (a, b) => b.outlier - a.outlier, views: (a, b) => b.views - a.views,
      vpd: (a, b) => b.viewsPerDay - a.viewsPerDay, recent: (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt),
    };
    const list = visibleVideos().filter((v) =>
      (!f.niche || D.channelById.get(v.channelId).nicheIds.includes(f.niche)) &&
      (f.format === 'all' || v.format === f.format) && v.outlier >= f.min && (!q || v.title.toLowerCase().includes(q)),
    ).sort(sorters[f.sort] || sorters.outlier);
    grid.innerHTML = list.slice(0, shown).map(thumbCard).join('');
    $('#count').textContent = hasData() ? `${plural(list.length, 'video')} match.` : '';
    $('#more').innerHTML = list.length > shown ? '<button class="btn" type="button" id="moreBtn">Show more</button>' : '';
    if (!list.length && hasData()) grid.innerHTML = '<p class="muted">Nothing matches these filters. Lower the minimum outlier or clear the search.</p>';
    const qs = new URLSearchParams({ ...(f.niche && { niche: f.niche }), ...(f.format !== 'all' && { format: f.format }), min: f.min, sort: f.sort, ...(f.q && { q: f.q }) });
    history.replaceState(null, '', `#/thumbnails?${qs}`);
    $('#moreBtn')?.addEventListener('click', () => { shown += 48; draw(false); });
  };
  $('#fn').addEventListener('change', (e) => { f.niche = e.target.value; draw(); });
  $('#fm').addEventListener('change', (e) => { f.min = Number(e.target.value); draw(); });
  $('#fs').addEventListener('change', (e) => { f.sort = e.target.value; draw(); });
  $('#fq').addEventListener('input', (e) => { f.q = e.target.value; draw(); });
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    f.format = b.dataset.format;
    $$('.seg button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    draw();
  }));
  draw();
}

function renderChannel(id) {
  const c = D.channelById.get(id);
  if (!c || !channelVisible(c)) return notFound('That channel is not in the data.');
  document.title = `${c.title} | Faceless Radar`;
  const vids = D.videos.filter((v) => v.channelId === id).sort((a, b) => b.outlier - a.outlier);
  const niches = c.nicheIds.map((n) => D.nicheById.get(n)).filter(Boolean);
  const review = D.reviews.channels?.[id];
  view.innerHTML = `<a class="back" href="#/niches">Back to all niches</a>
    <header class="page-head" style="margin-top:10px"><div class="cell-ch">${avatar(c)}<h1>${esc(c.title)}</h1></div>
    <p class="lede">${niches.map((n) => `<a href="#/niche/${esc(n.id)}">${esc(n.name)}</a>`).join(', ')}</p>
    <p><a href="${ytChannel(safeId(c.id) || '')}" target="_blank" rel="noopener noreferrer">Open on YouTube</a></p></header>
    <dl class="facts">
      <div><dt>Subscribers</dt><dd>${fmtNum(c.subs)}</dd></div>
      <div><dt>Typical video</dt><dd>${fmtNum(c.baseline?.long)}<small>views, long-form</small></dd></div>
      <div><dt>Typical Short</dt><dd>${fmtNum(c.baseline?.short)}<small>views</small></dd></div>
      <div><dt>Best outlier</dt><dd>${fmtX(c.bestOutlier60d)}<small>last 60 days</small></dd></div>
      <div><dt>Upload pace</dt><dd>${c.uploadsPerWeek ?? '–'}<small>videos per week</small></dd></div>
      <div><dt>Started</dt><dd>${c.createdAt ? new Date(c.createdAt).getFullYear() : '–'}<small>${badgeOrPending(c.id)}</small></dd></div>
    </dl>
    ${review?.note ? `<p class="muted" style="margin-top:16px;max-width:70ch">${esc(review.note)}</p>` : ''}
    <section><div class="sec-head"><h2>Standout videos</h2></div>
    ${vids.length ? `<div class="tgrid">${vids.map(thumbCard).join('')}</div>` : '<p class="muted">No videos beat this channel\'s typical views in the last 90 days.</p>'}</section>`;
}

function renderAbout() {
  document.title = 'Method | Faceless Radar';
  const t = D.meta.breakoutThreshold ?? 5;
  view.innerHTML = `<header class="page-head"><h1>Method</h1><p class="lede">How the numbers are produced, and where they can mislead you.</p></header>
  <div class="prose">
    <h2>Where the data comes from</h2>
    <p>Every day a script searches YouTube for each tracked niche, collects the channels behind the most-viewed recent videos, then reads each channel's latest uploads through the official YouTube Data API. Thumbnails are loaded straight from YouTube. Nothing is scraped from other research tools.</p>
    <h2>Outlier score</h2>
    <p>The outlier score divides a video's views by the median views of that channel's last 30 videos of the same format (long-form or Shorts). A score of 12× means the video got twelve times what the channel normally gets. Videos younger than two days are skipped because their views are still settling, and a channel needs at least four videos of a format to have a baseline.</p>
    <h2>Opportunity score</h2>
    <p>A 0 to 100 heuristic that rewards a niche for four things:</p>
    <ul><li>Up to 40 points for the breakout rate: the share of channels with a ${t}× video in the last 60 days. A video needs at least ${fmtNum(D.meta.breakoutMinViews ?? 0)} views to count, so tiny channels with a tiny baseline do not inflate the score.</li>
    <li>Up to 25 points for newcomer wins: the share of channels under a year old with a video above 50,000 views.</li>
    <li>Up to 20 points for estimated RPM. Niches without a public estimate get a neutral 10.</li>
    <li>Up to 15 points for low saturation: the fewer channels above 1 million subscribers, the higher the score.</li></ul>
    <p>It is a way to sort niches, not a forecast. Niches with fewer than 8 sampled channels are marked low confidence.</p>
    <h2>Faceless verification</h2>
    <p>YouTube does not tell anyone whether a channel shows a face. Search results are steered toward faceless formats, then a daily review checks channels and thumbnails and marks each one verified, not faceless or not reviewed yet. Channels marked not faceless are removed. Use "Verified faceless only" in the sidebar to hide everything that has not been reviewed.</p>
    <h2>Earnings estimates</h2>
    <p>RPM figures are gathered from public third-party articles. They disagree with each other, depend on audience country and season, and are not audited. Each niche page links its sources.</p>
    <h2>Limits</h2>
    <ul><li>The sample is the channels the search finds, not every channel on YouTube.</li>
    <li>A single viral video can make a small channel look like a trend.</li>
    <li>Subscriber counts are rounded by YouTube and hidden for some channels.</li></ul>
  </div>`;
}

function notFound(msg = 'Page not found.') {
  view.innerHTML = `<header class="page-head"><h1>Not found</h1><p class="lede">${esc(msg)} <a href="#/">Go to breakouts</a>.</p></header>`;
}

/* ---------- router and chrome ---------- */
const ROUTES = [
  [/^\/?$/, 'home', renderHome], [/^\/niches$/, 'niches', renderNiches], [/^\/niche\/([\w-]+)$/, 'niches', renderNiche],
  [/^\/thumbnails$/, 'thumbnails', renderThumbs], [/^\/channel\/([\w-]+)$/, 'niches', renderChannel], [/^\/about$/, 'about', renderAbout],
];

function route(scroll = true) {
  const [path, qs = ''] = (location.hash.slice(1) || '/').split('?');
  for (const [re, key, fn] of ROUTES) {
    const m = re.exec(path);
    if (!m) continue;
    $$('.links a').forEach((a) => (a.dataset.route === key ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
    try {
      fn(m[1], new URLSearchParams(qs));
    } catch (err) {
      view.innerHTML = `<p class="error">Something went wrong while drawing this page: ${esc(err.message)}</p>`;
    }
    if (scroll) { window.scrollTo(0, 0); view.focus({ preventScroll: true }); }
    return;
  }
  notFound();
}

const tip = $('#tip');
function showTip(el) {
  tip.textContent = el.getAttribute('data-tip');
  tip.hidden = false;
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left + r.width / 2 - tip.offsetWidth / 2, innerWidth - tip.offsetWidth - 8));
  const y = r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${y}px`;
}
document.addEventListener('mouseover', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (el && el.getAttribute('data-tip')) showTip(el); else tip.hidden = true;
});
document.addEventListener('scroll', () => { tip.hidden = true; }, { passive: true });
document.addEventListener('error', (e) => {
  if (e.target instanceof HTMLImageElement) e.target.style.visibility = 'hidden';
}, true);

async function boot() {
  try {
    await load();
  } catch (err) {
    view.innerHTML = `<p class="error">${esc(err.message)}</p>`;
    return;
  }
  $('#updated').textContent = D.meta.updatedAt ? `Updated ${ago(D.meta.updatedAt)}` : 'No data collected yet';
  const toggle = $('#verifiedOnly');
  toggle.checked = settings.verifiedOnly;
  toggle.addEventListener('change', () => {
    settings.verifiedOnly = toggle.checked;
    try { localStorage.setItem('fr.verified', toggle.checked ? '1' : '0'); } catch { /* ignore */ }
    route(false);
  });
  window.addEventListener('hashchange', () => route());
  route();
}
boot();
