import rateLimit from "express-rate-limit";

/**
 * 60 requests per minute per IP for all /api routes.
 * Stricter for the /api/search endpoint (10 per minute) — applied in route.
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip(req) {
    const path = String(req.originalUrl || req.path || "");
    return (
      path.includes("/api/search/status/") ||
      path.includes("/api/search/locations")
    );
  },
  message: { error: "Too many requests — please try again in a minute." },
});

export const searchLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 12,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Search rate limit exceeded — please wait before searching again.",
  },
});
