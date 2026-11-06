# Daily analysis task

This is the instruction for the daily AI review of Faceless Radar. It is meant to run once a day,
about two hours after the GitHub Action has collected fresh YouTube data (the Action runs at 09:17 UTC, just after the YouTube API quota resets at midnight Pacific time).

## What this task is for

The collector gathers numbers. It cannot tell whether a channel shows a face, why a thumbnail works,
or which new niches are rising. This task adds that judgement to the site, without touching any numbers.

## Files you may change

| File | Purpose |
|---|---|
| `site/data/reviews.json` | Faceless verdicts for channels and style tags for videos |
| `site/data/niche_notes.json` | Written thumbnail formula and title patterns per niche |
| `site/data/analysis.json` | The short "What changed" note on the home page |
| `config/niches.json` | Add up to 3 new niches per day |

Never edit `channels.json`, `videos.json`, `niches.json`, `feed.json`, `meta.json` or `state/state.json`.
The collector owns them and would overwrite your edits.

## Steps

1. `git pull`. Read `site/data/meta.json`. If `updatedAt` is not from today (UTC), stop: the collector has not run yet.
2. **Faceless review.** Take up to 25 channels from `site/data/channels.json` that are not yet in `reviews.json`,
   highest `bestOutlier60d` first. For each one, look at its thumbnails (`https://i.ytimg.com/vi/<videoId>/mqdefault.jpg`
   for the ids in `videos.json`) and its video titles. If the thumbnails cannot be loaded, judge from titles
   and channel name only and say so in the note.
   - Faceless means no on-camera presenter or creator face as the main element. Narration over stock footage, AI art,
     animation, maps, gameplay and screen recordings all count. Faces inside archival footage or art do not.
   - Write `{ "faceless": true | false, "note": "<140 characters at most>", "reviewedOn": "YYYY-MM-DD" }` under `channels.<channelId>`.
   - If you cannot tell, skip the channel. Do not guess. A channel left out stays "not reviewed yet" on the site.
   - The site covers English-language channels only. YouTube search lets some Hindi, Spanish and other channels through.
     If the titles or channel name make it clear the channel is not in English, add `"english": false` to its entry
     (keep `faceless` as you judged it, or omit it if you did not check). The collector drops such channels on its next run.
3. **Thumbnail tags.** For the 30 highest-outlier videos that have no entry yet, add `videos.<videoId> = { "tags": [...] }`
   with 1 to 4 tags from this list only: `big-text`, `text-free`, `number-or-countdown`, `ai-art`, `stock-footage`, `map`,
   `silhouette`, `split-compare`, `arrow-or-circle`, `dark-moody`, `bright-saturated`, `single-subject`, `collage`,
   `screenshot-ui`, `chart-graph`, `illustration-animation`, `3d-render`. Only tag what you actually looked at.
4. **Niche notes.** For the 5 niches with the most new data (compare against the latest file in `site/data/history/`),
   update `niche_notes.json`: `summary` (280 characters at most), `thumbnailFormula` (3 to 5 bullets, 100 characters each at most),
   `titlePatterns` (2 to 4), `updatedOn`. Base every bullet on thumbnails and titles you looked at today.
5. **New niches.** Use web search to find faceless niches that are rising this week. Add at most 3 to `config/niches.json` with:
   a kebab-case `id`, `name`, an existing `group`, a one-sentence `description`, 2 to 3 search `queries`, and `docs: true` for
   long documentary-style niches. Add `rpm` only when a source gives real numbers, and include its label and URL.
   Skip anything that duplicates an existing niche. The collector picks new niches up on its next run and the feed announces them.
6. **Analysis note.** Write `analysis.json`:
   `{ "date": "YYYY-MM-DD", "headline": "<80 characters>", "paragraphs": ["<300 characters>", ...], "watch": ["<nicheId>", ...] }`
   with 2 to 3 paragraphs and at most 3 niches in `watch`. Mention the niches whose opportunity score moved most since yesterday,
   one or two notable breakouts, and any niches you added.
7. Check that every changed JSON file still parses (`node -e "JSON.parse(require('fs').readFileSync('<file>'))"`),
   then commit with the message `analysis: YYYY-MM-DD` and push to `main`. The push redeploys the site.

## Rules

- Every number in your writing must come from the data files. Never invent a statistic, a channel or a quote.
- Keep the tone plain and factual. No hype, no income promises.
- If you run short of time, do step 2 first, then 6, then the rest.
