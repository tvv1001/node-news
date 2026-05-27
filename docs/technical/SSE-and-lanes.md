# SSE stream and lane architecture

This document describes the server-sent events (SSE) stream used by the frontend to receive live context-feed updates, and explains how "lanes" are assigned and limited in the UI.

## SSE endpoint

- Path: `GET /api/context/stream`
- Implemented in: `server/routes/context.js`
- Behavior:
  - The endpoint sends an initial `snapshot` event containing the full `getContextFeedSnapshot()` payload and a `streamVersion` id.
  - Subsequent updates are emitted as `snapshot` events via the `subscribeToContextFeedMonitor` callback.
  - A periodic heartbeat is emitted (native SSE comment lines) to keep connections alive.
  - Helper used to send messages: `writeSseEvent(res, { event, id, data })` in `server/routes/context.js`.

Clients (the browser worker in `src/workers/contextMonitorWorker.ts`) should connect with an EventSource or fetch-style SSE client and expect JSON payloads in the `data` field.

Example event shape:

{ "event": "snapshot", "id": <number>, "data": { "reason": "initial" | "update", "snapshot": { /_ full monitor snapshot on initial _/ }, /_ or incremental payload fields returned by the monitor _/ } }

## Message/data shape

Feed items delivered in snapshots follow the internal feed-item shape used across the app. Common fields consumed by the UI include:

- `id` — stable item id
- `title`, `summary` — text
- `link`, `commentsLink`, `originalLink` — URLs
- `source`, `homepage`, `feedUrl` — origin metadata
- `publishedAt`, `discoveredAt` — timestamps
- `tags` — array of tag strings
- `matchedKeywords` — which tag expressions matched
- `previewImage` — { src, alt } where `src` may be an image URL, a direct video URL (mp4/webm), or a provider embed URL
- `type` — e.g. `general-news`

Client-side rendering (see `src/components/FeedCard.tsx`) now inspects `previewImage.src` and `link` to decide whether to render an `<img>`, an HTML5 `<video>` element (for direct video files), or an `<iframe>` embed (for third-party embeds such as Reddit media). Keep the server-side `previewImage.src` populated when possible to ensure proper client rendering.

## Lanes (UI columns) and limits

The dashboard uses several "lanes" (ticker-style columns) to separate streams of content. The main implementations live in `src/components/ContextFeedColumn.tsx` and `src/components/App.tsx`.

Common lanes:

- News Lane / "All news" — default left column (tag value `all-news`). This lane is sized for broad coverage and shows curated general news. Limit: 40 items.
- Tagged Lane — per-tag lane (when you add a tag to a column). Limit: 10 items per tagged lane.
- Research / Pipeline lane — used for research results, model responses, or pipeline-specific feeds. Uses the same lane limit selection logic (tagged vs all-news) depending on the active tag.

How limits are determined:

- Function: `getLiveFeedLaneLimit(activeTag, contextFilter)` in `src/components/ContextFeedColumn.tsx`.
  - If `activeTag` is the special `all-news` tag and `contextFilter === 'news'`, the lane limit is `ALL_NEWS_LANE_LIMIT` (40).
  - Otherwise the lane limit is `TAGGED_LANE_LIMIT` (10).

How items are selected for a lane:

- Lane population combines several sources (general news, matches, context-specific items) and filters out suppressed or future-dated items.
- Suppression/filtering logic lives in `src/components/liveFeedSourcePolicy.ts` and `src/components/contextFeedChronology.ts`:
  - `isSuppressedLiveFeedItem(item)` returns true for items that should not appear in live lanes (e.g., search-result landing pages, low-value finance landing pages).
  - `getLiveFeedRecencyPriority(item)` is used to prefer fresh or high-priority sources (X/Twitter status, Reddit post, Google News, Yahoo, etc.).

## Which lanes subscribe to SSE

- The browser worker `src/workers/contextMonitorWorker.ts` subscribes to `/api/context/stream` and forwards updates to the React app (`src/components/App.tsx`) via a shared `contextMonitor` object.
- Each `ContextFeedColumn` pulls data from the shared monitor snapshot and applies its own filtering (by tag and contextFilter). The columns are not separate SSE subscriptions per lane; they share the single SSE connection and derive lane contents locally.

## Server-side responsibilities and recommendations

- The server should populate `previewImage.src` and, when possible, include `type` metadata for each item. The document parser and crawlers already attempt to populate these in `server/services/crawler/documentParser.js`.
- Keep SSE message payloads small for frequent updates: send diffs when feasible, but the current implementation sends `snapshot` updates. The client merges snapshots with a hydration strategy in `ContextFeedColumn` (`mergeHydratedFeedItems`).

## Testing and troubleshooting

- Tests relevant to SSE/lane behavior:
  - `node --test server/contextFeedService.test.js`
  - `node --test server/documentParser.test.js` (ensures preview/media parsing)
  - `node --test src/components/liveFeedSourcePolicy.test.ts` (policy suppressions and priorities)

- Manual validation:
  - Start backend: `pnpm --filter server run dev` (or `pnpm run dev:server`)
  - Open the app and inspect `Network` → `EventStream` connection to `/api/context/stream` to ensure `snapshot` messages arrive.
  - Confirm `previewImage.src` values for video posts are direct media URLs or known embed URLs; verify `FeedCard` renders them.

## Notes

- The live lanes are populated client-side from the single SSE stream; if you need per-lane filtering server-side (e.g., separate channels for extremely noisy feeds), consider adding route parameters or multiple SSE endpoints and updating `contextMonitorWorker.ts` to manage multiple EventSource connections.

References:

- `server/routes/context.js` (SSE endpoint and writeSseEvent)
- `server/services/crawler/documentParser.js` (previewImage/video discovery)
- `src/components/ContextFeedColumn.tsx` (lane limits, hydration)
- `src/components/liveFeedSourcePolicy.ts` (suppression and prioritization)
- `src/components/FeedCard.tsx` (preview rendering rules)
