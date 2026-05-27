/**
 * Minimal RSS integrator stub used for API during development.
 */

export async function fetchFeedsSummaries({ limit = 10, itemsPerFeed = 1 } = {}) {
	// Return empty list to keep API stable.
	return [];
}

export default { fetchFeedsSummaries };
