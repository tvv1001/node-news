/**
 * Minimal texasScraper shim.
 */

export function isTexasSearch(params = {}) {
	const state = String(params.state || '').toLowerCase();
	return state === 'tx' || state === 'texas' || Boolean(params.city && params.city.toLowerCase().includes('tx'));
}

export async function maybeSearchTexasRecords(query = {}) {
	// Return empty results quickly.
	return { results: [], fromCache: true };
}

export async function searchTexasRecords(query = {}) {
	return { results: [], fromCache: true };
}

export async function texasCountyForCity(city = '') {
	// Very small heuristic: return null for unknown.
	if (!city) return null;
	const normalized = String(city).toLowerCase();
	if (normalized.includes('dallas')) return 'Dallas';
	if (normalized.includes('travis') || normalized.includes('austin')) return 'Travis';
	return null;
}

export default { isTexasSearch, maybeSearchTexasRecords, searchTexasRecords, texasCountyForCity };
