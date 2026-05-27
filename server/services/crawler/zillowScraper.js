/**
 * Minimal zillowScraper shim to satisfy imports during development.
 * The real scraper was removed; provide a safe stub that returns null or
 * a basic structure so routes behave gracefully.
 */

export async function getZillowPropertyDetails(address) {
	if (!address) return null;
	// Return a minimal placeholder structure.
	return {
		address: String(address),
		price: null,
		beds: null,
		baths: null,
		sqft: null,
		zpid: null,
		raw: null,
	};
}

export default { getZillowPropertyDetails };
