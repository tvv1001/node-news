/**
 * Minimal NLP service shim.
 *
 * The full project previously provided richer NLP extraction. To keep the
 * app running after deletions, provide a small, safe implementation that
 * satisfies callers (returns empty arrays or simple extractions).
 */

export async function extractOrganizations(text = '') {
	// Very small heuristic: look for capitalized multi-word sequences as orgs.
	try {
		const input = String(text || '');
		if (!input.trim()) return [];

		const matches = [];
		const orgRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b/g;
		let m;
		while ((m = orgRe.exec(input))) {
			const candidate = m[1].trim();
			if (candidate.length > 3 && !matches.includes(candidate)) matches.push(candidate);
		}

		return matches.slice(0, 6);
	} catch (e) {
		return [];
	}
}

export default { extractOrganizations };
