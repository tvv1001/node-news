# Query Notify — architecture diagram

This diagram gives a high-level illustration of the system components and the data flows between them. It focuses on the live context-feed, crawler, and document parsing paths used by the dashboard.

```mermaid
flowchart LR
  subgraph Frontend
    A[Browser / Next.js UI]
    AW[contextMonitorWorker.ts] -->|EventSource /api/context/stream| S[Server: Express SSE]
    A -->|HTTP /api/*| S
    A -->|renders columns| CtxCols[ContextFeedColumns (3 lanes)]
    CtxCols -->|uses| FeedCard[FeedCard.tsx]
  end

  subgraph Server
    S[Server: Express SSE /api/context/stream] -->|subscribeToContextFeedMonitor| ContextService[contextFeedService]
    ContextService -->|reads/writes| DataLayer[lowdb JSON under server/data]
    ContextService -->|dispatch jobs| CrawlerSvc[searchEngines & crawlers]
    CrawlerSvc -->|fetch URLs| DocumentParser[documentParser.js]
    DocumentParser -->|returns artifacts| CrawlerSvc
    CrawlerSvc -->|match/normalize| ContextService
    ContextService -->|snapshot events| S
  end

  subgraph Services
    DocumentParser -->|extracts images, previews, videos| ImageStore[embedded images / data URIs]
    DocumentParser -->|extracts entities & dataLayer| EntityIndex[entity + dataLayer metadata]
    CrawlerSvc -->|supporting docs| DocumentParser
  end

  style DocumentParser fill:#f8f9fa,stroke:#333
  style ContextService fill:#eef6ff,stroke:#1e6fff
  style S fill:#fff3cd,stroke:#ff9900

  click DocumentParser href "./technical/documentParser.md" "Open documentParser details"
  click ContextService href "../server/services/context/contextFeedService.js" "Open contextFeedService"
```

How to view

- The Mermaid block above renders in most Markdown previewers (VS Code built-in preview). It links to the document-parser details file for quick navigation.

Notes

- The diagram intentionally uses a single SSE connection shared by all UI lanes; lane selection and hydration occur client-side (`ContextFeedColumn.tsx`).
- The parser is central to producing `previewImage` and `imageContext` artifacts used by cards; improving parser previews directly improves UI fidelity.
