# Query Notify

Query Notify is a full-stack contextual search and live-feed app for deed and record research. It pairs a Next.js/React dashboard with a Node.js crawler backend and a separate context-feed service so you can run record-aware searches, monitor tagged news, and review supporting documents from one interface.

The current app is intentionally focused on **contextual search**, **state and national record lookups**, and **tag-driven news monitoring**. Legacy person-profile and alert-sidebar flows have been removed.

## What it does

- Runs crawler-backed searches from a freeform query or direct source URL
- Preserves Google-style operator queries such as `site:gov "land records" after:2025-01-01`
- Enriches results with state and national record sources for contextual deed research
- Parses linked documents and extracts text, metadata, and media previews
- Streams live tag-matched news into the dashboard through a dedicated context-feed service
- Supports ticker-style tags and boolean tag expressions such as:
  - `$tsla`
  - `ai OR robotics`
  - `housing AND permits`
  - `site:theverge.com ai after:2026-01-01`
- Persists search runs and reference data under `server/data/`

## Current UI layout

The current dashboard is a compact three-column layout:

1. **General news column**
   - auto-refreshing general headlines
   - newest items first
   - article timestamps shown on cards

2. **Tagged news column**
   - add a tag when the column is empty
   - once a tag exists, the input hides and the feed focuses on saved tags
   - tags can be removed directly from their pills

3. **Search column**
   - main search form
   - crawler-backed contextual results

### Management Portal

The **SSE Dashboard** (`/sse-dashboard`) provides a detailed view of the context feed service:

- **Status**: Live monitor state, last update times, and errors.
- **Configuration**: Internal refresh intervals, match limits, and active search engines.
- **Catalog**: Complete list of active RSS/Search feeds generated from your tags.
- **Sources**: Reference of built-in and catalog-sourced news providers.
- **Output**: Direct view of recent matches and general news items.

There is **no left alert sidebar**, **no notification rail**, and **no person-profile UI** in the current product.

## Architecture overview

### Frontend

- **Framework:** Next.js 15 App Router with React 19 and TypeScript
- **Entry page:** `src/app/page.tsx`
- **Main shell:** `src/components/App.tsx`
- **HTTP client:** `src/api.ts`
- **Live feed worker:** `src/workers/contextMonitorWorker.ts`

### Backend service

The repository runs a unified **Express API server** on port `3001`:

- search jobs and crawler orchestration
- state and national record endpoints
- Texas / OSCN / RSS routes
- tag CRUD and live monitor snapshots
- server-sent event stream for browser updates

## Data flow

1. The frontend starts a search with `POST /api/search/start`
2. The browser polls `GET /api/search/status/:jobId`
3. The server runs crawler and enrichment pipelines
4. Results are normalized into contextual search payloads
5. The server refreshes general news and tag-matched feeds in the background
6. A browser worker subscribes to `/api/context/stream` and updates React state

## Repository structure

```text
src/
  api.ts                     Frontend API wrapper
  app/
    layout.tsx              Global HTML shell
    page.tsx                Next.js page entrypoint
  components/
    App.tsx                  Main React app shell
    GeneralNewsColumn.tsx    Left column for general news
    ContextFeedColumn.tsx    Middle column for saved tags and tagged news
    SearchForm.tsx           Main search input
    ResultsList.tsx          Search result rendering
  workers/
    contextMonitorWorker.ts Browser worker for context monitor fetch/SSE lifecycle

server/
  index.js                  Main Express API service (unified)
  routes/
    search.js               Search job endpoints and crawler orchestration
    texas.js                Texas record helpers
    oscn.js                 OSCN court-record endpoints
    rss.js                  RSS summary endpoint
    context.js              Context feed monitor/tag/SSE routes
  services/
    crawler/                Search engines, document parsing, result aggregation, Scrapy bridge
    context/                Context feed matching and refresh logic
    dataLayer/              Persistence helpers
    dataMerge/              Merge utilities
    rssIntegrator.js        RSS aggregation/summarization
  data/                     Persisted runs, reference datasets, caches, and record artifacts

scripts/
  okcounty-collect.js       One-off county data collection script
```

## Requirements

- **Node.js** 20+ recommended
- **pnpm** (`pnpm@10.33.0` is configured in the root package)
- Optional: **Python 3** for the Scrapy bridge
- Optional: Chrome / Chromium for Puppeteer-backed crawling

## Installation

From the repository root:

```bash
pnpm install
```

Notes:

- Root `postinstall` also installs backend dependencies inside `server/`
- The repo already contains a root `.env` for local development; do not overwrite existing secrets
- Use `server/.env.example` as the safe backend template

## Running the app

### Full development stack

```bash
pnpm run dev
```

This starts:

- Next.js frontend
- unified API server (`3001`)

If you only want the frontend + API, use:

```bash
pnpm run dev:app
```

To shut everything down again:

```bash
pnpm run stop
```

### Individual services

```bash
pnpm run dev:client
pnpm run dev:server
```

### Production-style frontend build

```bash
pnpm run build
pnpm run preview
```

## Available scripts

### Root scripts

| Script                      | Purpose                                                 |
| --------------------------- | ------------------------------------------------------- |
| `pnpm run dev`              | Start frontend + unified API server                     |
| `pnpm run dev:app`          | Run frontend + unified API server together              |
| `pnpm run dev:client`       | Start Next.js dev server on port `3000`                 |
| `pnpm run dev:server`       | Start unified API server with watch mode on port `3001` |
| `pnpm run stop`             | Stop frontend/API ports                                 |
| `pnpm run build`            | Build Next.js frontend                                  |
| `pnpm run preview`          | Preview the built frontend                              |
| `pnpm run collect-okcounty` | Run the Oklahoma county collection helper               |

### Server scripts

| Script                               | Purpose                              |
| ------------------------------------ | ------------------------------------ |
| `pnpm --dir server run dev`          | Watch unified API server             |
| `pnpm --dir server run scrapy:crawl` | Run the Python Scrapy crawler bridge |

## Environment variables

Use `server/.env.example` as the backend template.

### Common backend variables

| Variable                                                          | Default                 | Purpose                                                                |
| ----------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------- |
| `PORT`                                                            | `3001`                  | Unified API server port                                                |
| `FRONTEND_ORIGIN`                                                 | `http://localhost:5173` | CORS baseline for frontend access                                      |
| `REQUEST_TIMEOUT_MS`                                              | `15000`                 | Upstream request timeout                                               |
| `BING_API_KEY`                                                    | unset                   | Bing search integration                                                |
| `SERP_API_KEY`                                                    | unset                   | SerpAPI integration                                                    |
| `GOOGLE_ALERTS_FEEDS_JSON`                                        | unset                   | Optional JSON array of Google Alerts RSS feeds for the context monitor |
| `X_FEED_REFRESH_MS`                                               | `60000`                 | Faster refresh interval for X-backed live feeds                        |
| `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` / `GOOGLE_CHROME_BIN` | unset                   | Browser executable overrides                                           |

### Frontend environment variables

| Variable                        | Default                 | Purpose                 |
| ------------------------------- | ----------------------- | ----------------------- |
| `NEXT_PUBLIC_API_URL`           | `http://localhost:3001` | Unified API base URL    |
| `NEXT_PUBLIC_CONTEXT_API_URL`   | unset                   | Optional override       |
| `NEXT_PUBLIC_SEARCH_POLL_MS`    | `1000`                  | Search polling interval |
| `NEXT_PUBLIC_SEARCH_TIMEOUT_MS` | `600000`                | Search polling timeout  |

### X session authentication

The dashboard now includes an **X session login** that validates the two browser cookies the scraper already needs:

- `auth_token`
- `ct0`

When you paste those into the app, the server verifies them against X and stores the active scraper session in memory for the current server run.

You can still use `X_AUTH_TOKEN` and `X_CSRF_TOKEN` in `server/.env` as the fallback default session for headless/server startup.

## Key HTTP endpoints

### Unified API (`3001`)

| Method   | Path                            | Purpose                               |
| -------- | ------------------------------- | ------------------------------------- |
| `POST`   | `/api/search/start`             | Start a background search job         |
| `GET`    | `/api/search/status/:jobId`     | Poll live search progress and results |
| `POST`   | `/api/search`                   | Run a synchronous search              |
| `GET`    | `/api/search/locations`         | Search city/state suggestions         |
| `GET`    | `/api/search/zillow`            | Fetch Zillow property details         |
| `POST`   | `/api/search/scrapy-crawl`      | Trigger the Scrapy bridge             |
| `GET`    | `/api/search/history`           | List saved search runs                |
| `GET`    | `/api/search/history/:runId`    | Fetch one saved run                   |
| `GET`    | `/api/search/background-status` | Background crawler status             |
| `GET`    | `/api/texas/city-check`         | Check Texas county match for a city   |
| `POST`   | `/api/texas/search`             | Texas record search                   |
| `GET`    | `/api/texas/cache`              | Inspect Texas cache                   |
| `DELETE` | `/api/texas/cache`              | Clear Texas cache                     |
| `GET`    | `/api/oscn/counties`            | List OSCN counties                    |
| `POST`   | `/api/oscn/search`              | OSCN name search                      |
| `POST`   | `/api/oscn/case`                | OSCN case-detail fetch                |
| `DELETE` | `/api/oscn/cache`               | Clear OSCN cache                      |
| `GET`    | `/api/rss/summaries`            | RSS summary aggregation               |
| `GET`    | `/api/context/monitor`          | Get the current monitor snapshot      |
| `GET`    | `/api/context/portal`           | Get detailed portal management data   |
| `GET`    | `/api/context/tags`             | Get the current tag list              |
| `GET`    | `/api/context/stream`           | SSE stream for live context updates   |
| `POST`   | `/api/context/tags`             | Add tags                              |
| `PUT`    | `/api/context/tags`             | Replace all tags                      |
| `DELETE` | `/api/context/tags`             | Remove tags or clear all              |
| `GET`    | `/health`                       | Health check                          |

## Tag and query syntax

The app supports both simple and operator-aware input.

### Search examples

- `deed transfer travis county`
- `site:gov "land records" after:2025-01-01`
- `"mineral deed" AND texas`

### Tag examples

- `$tsla`
- `housing OR zoning`
- `permits AND austin`
- `site:theverge.com ai`
- `"quantum computing" -crypto`

Ticker tags can route to finance-oriented sources, while boolean and advanced operator tags are preserved for matching and feed construction.

## Testing and validation

The repository uses the Node.js built-in test runner.

### Available tests

- `node --test server/searchEngines.test.js`
- `node --test server/documentParser.test.js`
- `node --test server/contextFeedService.test.js`
- `node --test server/rssIntegrator.test.js`

### Suggested validation by area

| Area changed                    | Recommended validation                          |
| ------------------------------- | ----------------------------------------------- |
| Search engine crawler logic     | `node --test server/searchEngines.test.js`      |
| Document parsing / previews     | `node --test server/documentParser.test.js`     |
| Context feed / tags / live feed | `node --test server/contextFeedService.test.js` |
| RSS summary ordering            | `node --test server/rssIntegrator.test.js`      |
| Frontend build sanity           | `pnpm run build`                                |

## Data and persistence

Application state is persisted to JSON files under `server/data/`, including:

- `search-runs/`
- Texas / OSCN caches
- FINRA seed and reference data
- crawler reference datasets

Treat `server/data/` as local application state plus reference datasets, not purely static fixtures.
