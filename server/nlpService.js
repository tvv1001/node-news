import { logger } from './utils/logger.js';

let isReady = false;

const ORGANIZATION_SUFFIX_RE =
	/(University|Laboratory|Laboratories|Lab|Institute|Center|Centre|Foundation|Department|School|College|Society|Group|Press|Journals|Review|Physics|ResearchGate|Frontiers|Springer|arXiv|NASA|ADS|OSTI|Firm|Solutions|Ventures|Partners|Technologies|Systems|Global|International|Associates|Capital|Management|Industries)/;
const ORGANIZATION_CANDIDATE_RE = new RegExp(String.raw`\b(?:[A-Z][\w.&'-]*\s+){0,5}${ORGANIZATION_SUFFIX_RE.source}\b`, 'g');

function dedupeOrganizations(values = []) {
	const seen = new Set();
	return values.filter((value) => {
		const normalized = String(value || '').trim();
		if (!normalized) return false;
		const key = normalized.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function extractOrganizationsHeuristically(text = '') {
	const content = String(text || '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!content) return [];

	const matches = content.match(ORGANIZATION_CANDIDATE_RE) || [];
	return dedupeOrganizations(matches.map((value) => value.replace(/^[^A-Z]+|[^\w.)'-]+$/g, '').trim()).filter((value) => value.length >= 4)).slice(0, 8);
}

/**
 * Initializes the NLP manager for Named Entity Recognition (NER).
 * This loads the necessary language models and trains the NER.
 */
async function initializeNlpManager() {
	if (isReady) {
		return;
	}
	try {
		logger.info('Initializing lightweight organization extractor...');
		isReady = true;
		logger.info('Organization extractor ready.');
	} catch (error) {
		logger.error('Failed to initialize NLP manager:', error);
		isReady = false;
	}
}

/**
 * Extracts organization names from a given text using the initialized NLP manager.
 * @param {string} text The text to analyze.
 * @returns {Array<string>} An array of extracted organization names.
 */
async function extractOrganizations(text) {
	if (!isReady) {
		await initializeNlpManager(); // Ensure initialization if not already done
	}
	return extractOrganizationsHeuristically(text);
}

export { initializeNlpManager, extractOrganizations };
