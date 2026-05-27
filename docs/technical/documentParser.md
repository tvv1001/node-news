# documentParser.js — technical details

Location: `server/services/crawler/documentParser.js`

Purpose

- Fetch and extract textual content, images, video links, and metadata from remote documents and HTML pages so crawlers and the context-feed service can build normalized preview artifacts.

High-level responsibilities

- Retrieve content (binary/text) with safe timeouts/size caps.
- Parse PDFs (via `pdf-parse`) and optionally generate a first-page JPEG preview using a headless browser (Puppeteer).
- Extract raw text from DOCX via `mammoth`.
- Parse and paginate HTML pages with Cheerio + Readability fallbacks, extracting: main article text, dataLayer metadata, image context, embedded video links (YouTube), and supporting document links (PDFs).
- Derive structured artifacts: `text`, `previewImage`, `imageContext`, `dataLayer`, `supportingDocuments`, `videoLinks`, `publicRecordList`, and `entities` (phones/emails/addresses).
- Detect blocked or paywalled pages using pattern signals and score thresholds.

Key configuration and limits (env-aware)

- `REQUEST_TIMEOUT_MS` (default 15000)
- `MAX_DOC_BYTES` (10 MiB)
- `MAX_HTML_PAGINATION_PAGES` (default 3)
- `MAX_HTML_TEXT_CHARS` (120000)
- `MAX_SUPPORTING_DOCS`, `MAX_SUPPORTING_DOC_TEXT_CHARS` — supporting docs limits
- `PDF_PREVIEW_TIMEOUT_MS` and `PDF_PREVIEW_IMAGE_QUALITY` — PDF-preview capture controls
- `MAX_CONCURRENT_REQUESTS` (parseDocuments concurrency; default 5)

Major functions and flows

- fetchBinaryResponse(url) / fetchText(url)
  - axios-backed HTTP helpers with sane headers and size/time limits.

- isPdfLikeUrl(url) / isRepositoryPdfDownloadUrl(url)
  - Heuristics to detect PDFs and repository download endpoints (e.g., `cgi/viewcontent.cgi`).

- parsePDF(url)
  - Uses `pdf-parse` to extract `.text`.
  - Extracts related figure context by probing for a related HTML view and embedding images where possible.
  - Attempts to generate a JPEG preview of the first page using Puppeteer (headless browser) as fallback when no inline figure images are available.

- parseDOCX(url)
  - Fetches binary then uses `mammoth.extractRawText` to recover text.

- parseHTML(url)
  - Performs limited pagination (up to `MAX_HTML_PAGINATION_PAGES`) following `rel=next` and common pagination patterns.
  - Extracts dataLayer metadata from inline scripts by parsing loose JS object literals used in `dataLayer` pushes/assignments.
  - Extracts image context (meta `og:image`, `<figure>`/`<img>` candidates) and filters non-content images via heuristics (filename, alt text, surrounding DOM position).
  - Extracts YouTube links and normalizes them into canonical watch URLs.
  - Discovers supporting document links (PDFs) and scores them; will parse up to `MAX_SUPPORTING_DOC_LINKS` support docs and merge their text and image context.
  - Attempts to use Readability (Mozilla) first; falls back to selector heuristics (`main article`, `.entry-content`, etc.).

- extractEntitiesFromText(text)
  - Regex-based extraction for phone numbers, emails, and postal-address-like patterns.

- detectBlockedDocument(text, url)
  - Uses pattern matching and a small scoring system to decide whether a page appears blocked (captcha/gate), paywalled, or otherwise unsuitable for extraction.

- extractPublicRecordEntries(text, url)
  - Heuristics to identify 'public-record' lists (deeds, unclaimed property) and extract owner-name / address pairs.

- embedRenderableImageAssets(entries)
  - Attempts to `fetch` referenced images and embed them as data URIs (or SVG wrappers) when appropriate, limiting the final set to `MAX_IMAGE_CONTEXT_ENTRIES`.

Outputs (returned shape) The top-level `parseDocument(url)` returns an object similar to:

{ url, text, // merged primary + supporting docs + video link text language, // 'en' | 'non-en' | 'unknown' blocked: boolean, blockedReason: string, entities: { phones: [], emails: [], addresses: [] }, dataLayer: { entries: [], text: '' }, imageContext: { entries: [], renderableEntries: [], text: '' }, supportingDocuments: { urls: [], documents: [{ url, text, previewImage, imageContext }] }, previewImage: { src, alt, caption, originUrl } | null, publicRecordList: { listType, state, entries: [] } }

Notes on previewImage/video handling (important for cards)

- `previewImage.src` may be:
  - an `og:image`/page image URL (preferred)
  - an embedded data URI (if image embedding succeeded)
  - a generated PDF JPEG preview (data URI) when parsing PDFs
- Video discovery:
  - YouTube links are extracted and normalized; the parser exposes up to 3 YouTube watch URLs per page.
  - `videoLinks` are surfaced as a short `Video: <url>` text block appended to parsed `text` and as part of `supportingDocuments` when applicable.

Robustness, security, and operational concerns

- Resource caps and timeouts prevent the parser from stalling on huge or slow pages.
- The PDF screenshot flow requires a headless browser; `PUPPETEER_EXECUTABLE_PATH` or common Chrome binaries are probed. The server environment must provide an available browser binary to enable PDF preview generation.
- Image embedding increases payload sizes if embedded as base64; the code limits the number and only embeds small/photographic images.
- Blocking detection helps avoid charging for or stalling on paywalled/captcha-protected sites; such pages are flagged via `blocked` and the caller can skip storing or indexing them.

Testing and validation

- Unit and integration test hints in repo:
  - `node --test server/documentParser.test.js`
  - `node --test server/contextFeedService.test.js` (integration with context matching)
- Manual checks:
  - Run parser against known sample pages (arXiv abstract + PDF workflow, a news article with `og:image`, a Reddit thread with embedded media) to confirm `previewImage` and `videoLinks` are populated.

Recommendations / improvement areas

- Add explicit `previewType` (image | video | pdf-preview | embed) in returned artifact to simplify client rendering rules.
- Consider producing small thumbnail JPEGs (via Puppeteer) instead of full-page JPEG data URIs to reduce payload size.
- Improve non-YouTube video detection (Vimeo, reddit video blobs) and normalize a `video` artifact shape for clients to consume directly.
- Offer an option to return diffs or incremental image downloads (lazy image embedding) to keep initial SSE snapshots small.

References (in-repo locations)

- `server/services/crawler/documentParser.js`
- `server/routes/search.js` (where parsed text may be used)
- `server/services/context/contextFeedService.js` (how parsed artifacts are incorporated into matches)
- `src/components/FeedCard.tsx` (client rendering expectations for `previewImage`)
