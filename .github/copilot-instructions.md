# Query Notify

Query Notify is a full-stack contextual search and live-feed app. The frontend runs an Astro/React dashboard with a compact tag-driven feed and crawler-backed result cards; the backend runs search-engine crawlers, state and national record lookups, RSS integrations, and document parsing to return contextual search results and persisted search runs.

Prefer instructions in this file before searching the repo. Only do extra exploration when the information here is incomplete or appears outdated.

## Tech stack

- Frontend: Astro 6 with React 19 islands and Vite
- Backend: Node.js ESM with Express 4
- Data fetching and scraping: Axios, Cheerio, Puppeteer, rss-parser, simplecrawler
- Parsing and enrichment: `pdf-parse`, `mammoth`, `node-nlp`, `@mozilla/readability`, `jsdom`
- Persistence: `lowdb` JSON files under `server/data/`
- Logging and security: Winston, Helmet, CORS, `express-rate-limit`
- Tests: Node.js built-in test runner via `node --test`

## Project guidelines

- Use ESM imports/exports everywhere. Do not mix in CommonJS.
- Keep changes minimal and local; avoid broad refactors unless explicitly requested.
- Preserve the API contract between `src/api.js` and the Express routes.
- Prefer existing dependencies and built-in Node.js APIs over adding new packages.
- Keep search-result normalization consistent: results are generally shaped as `{ source, results }` and merged downstream.
- Do not weaken snippet sanitization or AI-overview filtering in crawler code; those guardrails prevent polluted SERP data.
- Follow the existing route/service split: route handlers under `server/routes/`, reusable logic under `server/services/`.
- Use the existing logger in `server/utils/logger.js` instead of ad hoc console noise for backend diagnostics.
- Preserve the current compact UI system: prefer `4px` corner radii and `8px` layout gaps unless a specific component needs a deliberate exception.
- If a change affects the crawler/search pipeline, also review `.github/agents/search-crawler.agent.md`.

## Project structure

- `src/pages/index.astro` - main Astro page; hydrates the React app
- `src/layouts/Layout.astro` - shared Astro HTML shell
- `src/components/` - React UI components such as `App.jsx`, `SearchForm.jsx`, and `ResultsList.jsx`
- `src/api.js` - frontend HTTP client and request helpers for `/api/*`
- `server/index.js` - Express app bootstrap, middleware, and route registration
- `server/routes/` - API surface for search, Texas data, OSCN, RSS, and context feeds
- `server/services/crawler/` - search engine crawlers, document parsing, Zillow/Texas scrapers, and the Scrapy bridge
- `server/services/dataLayer/` and `server/services/dataMerge/` - persistence models and merge logic
- `server/utils/` - logging and location normalization helpers
- `server/middleware/` - rate limiting and related Express middleware
- `server/data/` - persisted search runs and reference datasets
- `scripts/` - one-off data collection scripts such as `okcounty-collect.js`

## Working rules by area

### Frontend

- Keep Astro pages thin and place interactivity in React components.
- Treat `src/api.js` as the canonical client wrapper for backend endpoints.
- When changing UI state flows, keep loading, error, and results handling centralized in `src/components/App.jsx`.
- Keep the visual language compact and consistent: `4px` radii, `8px` gaps, restrained shadows, and no oversized card chrome unless asked.

### Backend

- Add new endpoints in a route file first, then wire them in `server/index.js`.
- Keep long-running search work asynchronous and compatible with the existing start/status job flow.
- Respect rate limiting, CORS, and Helmet defaults unless the task specifically requires changing them.

### Crawlers and aggregation

- Search engine crawler work lives primarily in `server/services/crawler/searchEngines.js` and `server/routes/search.js`.
- Do not merge or deduplicate specialized article/media results using a simpler rule than the current source-aware logic.
- The active search pipeline returns contextual `searchResults` plus AI summaries; it no longer builds or serves person-profile records.

## Build, run, and validation

- Preferred install from repo root: `pnpm install`
- Root install triggers `npm --prefix server install` via `postinstall`, so server dependencies are expected to be installed from the root workflow.
- Start full dev environment from repo root: `pnpm run dev`
- Start frontend only: `pnpm run dev:client`
- Start backend only: `pnpm run dev:server`
- Production build from repo root: `pnpm run build`
- Preview built frontend from repo root: `pnpm run preview`

Run targeted validation for the area you changed:

- Search engine crawler regressions: `node --test server/searchEngines.test.js`
- Document parsing regressions: `node --test server/documentParser.test.js`
- Context feed regressions: `node --test server/contextFeedService.test.js`
- RSS regressions: `node --test server/rssIntegrator.test.js`

When changing crawler or aggregation logic, prefer running the search engine, document parser, context feed, and RSS tests before finishing.

## Environment and configuration

- The repo contains a root `.env` for local development. Do not overwrite existing secrets.
- Use `server/.env.example` as the safe template for required backend variables.
- Important backend variables include `PORT`, `FRONTEND_ORIGIN`, `REQUEST_TIMEOUT_MS`, and API keys such as `BING_API_KEY` or `SERP_API_KEY`.
- Browser-based crawler logic may also rely on executable-path environment variables such as `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, or `GOOGLE_CHROME_BIN`.

## Useful resources for Copilot

- `.github/agents/search-crawler.agent.md` - specialized guidance for crawler, RSS, search API, and result aggregation work
- `package.json` - root scripts for install, dev, build, preview, and data collection
- `server/package.json` - backend runtime scripts
- `server/.env.example` - safe reference for backend setup
- `server/data/search-runs/` - persisted crawl/status artifacts useful when debugging search-job behavior

If you need to make a change and this file gives a path, trust that path first before doing broad repo-wide searches.

### SSE stream & live-lane docs

If you are changing live feed behavior or lane logic, review `docs/technical/SSE-and-lanes.md` for the SSE contract, lane limits, and where the client merges snapshots. The `ContextFeedColumn` and `server/routes/context.js` files are the canonical code references for lane sizing and SSE behavior.
