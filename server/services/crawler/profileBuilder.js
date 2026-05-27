/**
 * profileBuilder.js
 *
 * Aggregates raw results from search engines, people directories, and
 * document parsers into one normalized PersonProfile object.
 */

import { createPersonProfile, mergeProfiles } from '../dataLayer/person.js';
import { extractEntitiesFromText, parseDocuments } from './documentParser.js';
import { canonicalizeLocation, inferLocationByAddress, inferLocationByZip, isKnownCityName } from '../../utils/locationIndex.js';
import { logger } from '../../utils/logger.js';
import { findMLSByAddress, loadMLSData, toMLSRecord } from '../dataLayer/mlsData.js';

const DOC_EXTENSIONS = /\.(pdf|docx|doc)(\?.*)?$/i;

/**
 * Pulls the first address-like fragment from a free-text address string.
 */
function cleanStreetAddressValue(value = '') {
	const cleaned = String(value || '')
		.replace(/^.*?\b(?:lives?|resides?|located|address(?:es)?|current address)\s+(?:at|in)\s+/i, '')
		.replace(/^(?:age|aged)\s*\d{1,3}\s*/i, '')
		.replace(/^(?:\d{1,3}\s+)?(?:years? old\s+)?(?:lives?|resides?)\s+(?:at|in)\s+/i, '')
		.trim();

	const streetOnlyMatch = cleaned.match(
		/(\d{1,6}\s+(?:[NSEW]\s+)?[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,6}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?$/i,
	);

	return (streetOnlyMatch?.[1] || cleaned).trim();
}

function cleanLooseAddressNarrative(value = '') {
	const cleaned = String(value || '')
		.replace(/\b(?:More\s+)?View Details\b/gi, ' ')
		.replace(/\b(?:Get|View|More|Info|Details|Profile|Report|Records|Search|Results|Showing|Summary|FAQ)\b/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();

	const namedLocationMatch = cleaned.match(/^[A-Z][A-Za-z'.-]*(?:\s+[A-Z](?:[A-Za-z'.-]+)?){1,3}\s+([A-Z][A-Za-z .'-]+,\s*[A-Z]{2}(?:\s+\d{5}(?:-\d{4})?)?)$/);

	return normalizeStreetNarrative(namedLocationMatch?.[1] || cleaned);
}

function normalizeStreetNarrative(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/\s+,/g, ',')
		.trim();
}

function isLikelyNameFragment(words = []) {
	return words.length >= 2 && words.length <= 4 && words.every((word) => /^[A-Z](?:[A-Za-z'.-]+)?$/.test(word));
}

function cleanLooseCityValue(value = '') {
	const cleaned = normalizeStreetNarrative(cleanLooseAddressNarrative(value));
	const words = cleaned.split(/\s+/).filter(Boolean);

	for (let index = 0; index < words.length; index += 1) {
		const candidate = words.slice(index).join(' ');
		if (isKnownCityName(candidate)) {
			return candidate;
		}
	}

	for (let suffixLength = Math.min(3, words.length - 1); suffixLength >= 1; suffixLength -= 1) {
		const prefixWords = words.slice(0, -suffixLength);
		const suffixWords = words.slice(-suffixLength);

		if (isLikelyNameFragment(prefixWords)) {
			return suffixWords.join(' ');
		}
	}

	return cleaned;
}

function normalizeCountyValue(value = '') {
	const cleaned = String(value || '')
		.replace(/\bcounty\b/i, '')
		.replace(/\s+/g, ' ')
		.trim();

	if (!cleaned) return '';

	return `${cleaned
		.split(' ')
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
		.join(' ')} County`;
}

function splitAddress(raw = '') {
	const cleaned = normalizeStreetNarrative(cleanLooseAddressNarrative(raw));

	const locationOnlyMatch = cleaned.match(/^([A-Z][A-Za-z .'-]+?)\s*,\s*([A-Z]{2})(?:\s*(\d{5}(?:-\d{4})?))?(?:\s*,\s*([A-Za-z .'-]+\s+(?:County|Parish)))?$/i);

	if (locationOnlyMatch) {
		const normalized = canonicalizeLocation({
			city: cleanLooseCityValue(locationOnlyMatch[1] || ''),
			state: locationOnlyMatch[2] || '',
		});
		const inferred = inferLocationByZip(locationOnlyMatch[3] || '', normalized.state, normalized.city);

		return {
			address: '',
			city: normalized.city || inferred.city,
			state: normalized.state || inferred.state,
			zipCode: locationOnlyMatch[3] || '',
			county: normalizeCountyValue(locationOnlyMatch[4] || inferred.county || ''),
		};
	}

	const narrativeStreetMatch = cleaned.match(
		/(\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,6}\s+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?\s*,?\s*([A-Za-z .'-]+?)(?:,\s*|\s+)([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/i,
	);

	if (narrativeStreetMatch) {
		const address = cleanStreetAddressValue(narrativeStreetMatch[1] || '');
		const normalized = canonicalizeLocation({
			city: narrativeStreetMatch[2] || '',
			state: narrativeStreetMatch[3] || '',
		});
		const byAddress = inferLocationByAddress(address);
		const inferred = inferLocationByZip(narrativeStreetMatch[4] || byAddress.zipCode || '', byAddress.state || normalized.state, byAddress.city || normalized.city);

		return {
			address,
			city: byAddress.city || normalized.city || inferred.city,
			state: byAddress.state || normalized.state || inferred.state,
			zipCode: narrativeStreetMatch[4] || byAddress.zipCode || '',
			county: normalizeCountyValue(byAddress.county || inferred.county || ''),
		};
	}

	const streetMatch = cleaned.match(
		/^(.*?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?\s*,?\s*([A-Za-z .'-]+?)(?:,\s*|\s+)([A-Z]{2})\s*(\d{5}(?:-\d{4})?)?$/i,
	);

	if (streetMatch) {
		const address = cleanStreetAddressValue(streetMatch[1] || '');
		const normalized = canonicalizeLocation({
			city: streetMatch[2] || '',
			state: streetMatch[3] || '',
		});
		const byAddress = inferLocationByAddress(address);
		const inferred = inferLocationByZip(streetMatch[4] || byAddress.zipCode || '', byAddress.state || normalized.state, byAddress.city || normalized.city);

		return {
			address,
			city: byAddress.city || normalized.city || inferred.city,
			state: byAddress.state || normalized.state || inferred.state,
			zipCode: streetMatch[4] || byAddress.zipCode || '',
			county: normalizeCountyValue(byAddress.county || inferred.county || ''),
		};
	}

	const parts = cleaned.split(',').map((s) => s.trim());
	const normalized = canonicalizeLocation({
		city: cleanLooseCityValue(parts[1] || ''),
		state: parts[2]?.replace(/\d+/, '').trim() || '',
	});
	const address = cleanStreetAddressValue(parts[0] || cleaned);
	const zipCode = (parts[2]?.match(/\d{5}/) || parts[3]?.match(/\d{5}/) || [''])[0] || '';
	const byAddress = inferLocationByAddress(address);
	const inferred = inferLocationByZip(zipCode || byAddress.zipCode || '', byAddress.state || normalized.state, byAddress.city || normalized.city);
	const countyMatch = cleaned.match(/\b([A-Za-z .'-]+?)\s+County\b/i);

	return {
		address,
		city: byAddress.city || normalized.city || inferred.city,
		state: byAddress.state || normalized.state || inferred.state,
		zipCode: zipCode || byAddress.zipCode || '',
		county: normalizeCountyValue(countyMatch?.[1] || byAddress.county || inferred.county || ''),
	};
}

/**
 * Build a minimal profile from a directory result (already partially parsed).
 */
function fromDirectory(raw, source) {
	const addrParts = splitAddress(raw.address || '');
	const inferred = inferLocationByZip(raw.zipCode || addrParts.zipCode || '', raw.state || addrParts.state || '', raw.city || addrParts.city || '');
	const fallbackRawAddress = cleanLooseAddressNarrative(raw.address || '');
	const normalizedAddress = addrParts.address || (addrParts.city || addrParts.state || addrParts.county ? '' : fallbackRawAddress);

	return createPersonProfile({
		firstName: raw.firstName || '',
		middleName: raw.middleName || '',
		lastName: raw.lastName || '',
		age: raw.age || 0,
		ageText: raw.ageText || '',
		address: normalizedAddress,
		city: addrParts.city || raw.city || inferred.city,
		state: addrParts.state || raw.state || inferred.state,
		zipCode: addrParts.zipCode || raw.zipCode || '',
		county: addrParts.county || raw.county || inferred.county || '',
		country: raw.country || '',
		aliases: raw.aliases || [],
		phoneNumbers: raw.phoneNumbers || [],
		email: raw.email || '',
		socialMedia: raw.socialMedia || {},
		website: raw.website || '',
		occupation: raw.occupation || '',
		company: raw.company || '',
		mlsNumber: raw.mlsNumber || '',
		lastSoldDate: raw.lastSoldDate || '',
		lastSoldYear: raw.lastSoldYear || '',
		lastSoldTo: raw.lastSoldTo || '',
		grantor: raw.grantor || '',
		grantee: raw.grantee || '',
		court: raw.court || '',
		caseNumber: raw.caseNumber || '',
		caseType: raw.caseType || '',
		offenseDescription: raw.offenseDescription || '',
		disposition: raw.disposition || '',
		recordDate: raw.recordDate || '',
		offenseDate: raw.offenseDate || '',
		yearsAtAddress: raw.yearsAtAddress || '',
		otherNamesAtAddress: raw.otherNamesAtAddress || raw.relatives || [],
		relatives: raw.relatives || [],
		marriages: raw.marriages || [],
		formerAddresses: raw.formerAddresses || [],
		sources: raw.sources?.length ? raw.sources : [source],
		sourceUrls: raw.sourceUrls || (raw.website ? { [source]: raw.website } : {}),
	});
}

/**
 * Build a minimal profile fragment from extracted document entities.
 */
function combineEntities(...allEntities) {
	return {
		phones: [...new Set(allEntities.flatMap((entry) => entry?.phones || []).filter(Boolean))],
		emails: [...new Set(allEntities.flatMap((entry) => entry?.emails || []).filter(Boolean))],
		addresses: [...new Set(allEntities.flatMap((entry) => entry?.addresses || []).filter(Boolean))],
	};
}

function fromDocEntities(entities, source, searchParams = {}) {
	const primaryAddress = splitAddress(entities.addresses?.[0] || '');
	const inferred = inferLocationByZip(
		primaryAddress.zipCode || searchParams.zipCode || '',
		primaryAddress.state || searchParams.state || '',
		primaryAddress.city || searchParams.city || '',
	);

	return createPersonProfile({
		firstName: searchParams.firstName || '',
		middleName: searchParams.middleName || '',
		lastName: searchParams.lastName || '',
		phoneNumbers: entities.phones || [],
		email: entities.emails?.[0] || '',
		address: primaryAddress.address || entities.addresses?.[0] || '',
		city: primaryAddress.city || searchParams.city || inferred.city,
		state: primaryAddress.state || searchParams.state || inferred.state,
		zipCode: primaryAddress.zipCode || searchParams.zipCode || '',
		county: primaryAddress.county || inferred.county || '',
		formerAddresses: entities.addresses?.slice(1) || [],
		sources: [source || 'web search'],
	});
}

function extractAgeDetails(text = '') {
	const raw = String(text || '');
	const exactMatch = raw.match(/\b(?:age|aged)\s*[:\-]?\s*(\d{1,3})\b/i) || raw.match(/\b(\d{1,3})\s*(?:years? old|yrs? old)\b/i);

	if (exactMatch) {
		const age = Number(exactMatch[1] || 0);
		return {
			age: Number.isFinite(age) ? age : 0,
			ageText: age ? `Age ${age}` : '',
		};
	}

	const decadeMatch = raw.match(/\b(\d{2})s\b/i);
	if (decadeMatch) {
		return {
			age: 0,
			ageText: `${decadeMatch[1]}s`,
		};
	}

	return { age: 0, ageText: '' };
}

function extractLocationHint(text = '', searchParams = {}) {
	const raw = String(text || '');
	const cityStateMatch = raw.match(/\b([A-Z][A-Za-z .'-]+?),\s*([A-Z]{2})(?:\s+(\d{5}(?:-\d{4})?))?\b/);

	if (cityStateMatch) {
		const normalized = canonicalizeLocation({
			city: cityStateMatch[1] || '',
			state: cityStateMatch[2] || '',
		});

		const inferred = inferLocationByZip(cityStateMatch[3] || '', normalized.state, normalized.city);

		return {
			city: normalized.city || inferred.city,
			state: normalized.state || inferred.state,
			zipCode: cityStateMatch[3] || '',
			county: inferred.county || '',
		};
	}

	if (searchParams.city && searchParams.state && normalizeText(raw).includes(normalizeText(searchParams.city)) && normalizeText(raw).includes(normalizeText(searchParams.state))) {
		const inferred = inferLocationByZip(searchParams.zipCode || '', searchParams.state || '', searchParams.city || '');

		return {
			city: searchParams.city || inferred.city || '',
			state: searchParams.state || inferred.state || '',
			zipCode: searchParams.zipCode || '',
			county: inferred.county || '',
		};
	}

	return { city: '', state: '', zipCode: '', county: '' };
}

function enrichProfileWithMLS(profile = {}) {
	if (!profile.address) return profile;

	const match = findMLSByAddress(profile.address, profile.city, profile.state, profile.zipCode)[0];

	if (!match) return profile;

	const record = toMLSRecord(match);
	const matchedSoldYear = String(record.lastSoldDate || '').match(/\b(?:19|20)\d{2}\b/)?.[0] || '';

	return {
		...profile,
		city: profile.city || record.city || '',
		state: profile.state || record.state || '',
		zipCode: profile.zipCode || record.zipCode || '',
		mlsNumber: profile.mlsNumber || record.mlsNumber || '',
		lastSoldDate: profile.lastSoldDate || record.lastSoldDate || '',
		lastSoldYear: profile.lastSoldYear || matchedSoldYear,
	};
}

function splitLooseFullName(fullName = '') {
	const parts = String(fullName || '')
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	if (!parts.length) return { firstName: '', middleName: '', lastName: '' };
	if (parts.length === 1) {
		return { firstName: parts[0], middleName: '', lastName: '' };
	}

	return {
		firstName: parts[0],
		middleName: parts.slice(1, -1).join(' '),
		lastName: parts.at(-1) || '',
	};
}

const NON_PERSON_EVIDENCE_WORDS = new Set([
	'address',
	'phone',
	'email',
	'current',
	'former',
	'previous',
	'occupants',
	'occupant',
	'residents',
	'resident',
	'public',
	'records',
	'record',
	'details',
	'report',
	'search',
]);

function isLikelyEvidenceName(value = '') {
	const cleaned = String(value || '').trim();
	const parts = cleaned.split(/\s+/).filter(Boolean);

	return Boolean(
		cleaned &&
		!/\d/.test(cleaned) &&
		parts.length >= 2 &&
		parts.length <= 4 &&
		parts.every((part) => /^[A-Z][A-Za-z'.-]*$/.test(part) && !NON_PERSON_EVIDENCE_WORDS.has(part.toLowerCase())),
	);
}

function extractEvidenceNames(text = '', excludeNames = []) {
	const seen = new Set((excludeNames || []).map((value) => normalizeText(value)).filter(Boolean));
	const matches = String(text || '').match(/[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,2}/g) || [];

	return matches
		.map((value) =>
			String(value || '')
				.replace(/[,:;]+$/g, '')
				.trim(),
		)
		.filter((value) => isLikelyEvidenceName(value))
		.filter((value) => {
			const key = normalizeText(value);
			if (!key || seen.has(key)) return false;
			seen.add(key);
			return true;
		})
		.slice(0, 12);
}

function extractOccupantNames(text = '', searchParams = {}) {
	const sections = [
		String(text || '').match(
			/(?:associated people|associated persons|other names that have lived at address|other names at address|possible residents|other residents|residents|household members|previous occupants|previous residents)\s*:?\s*(.+?)(?:phone|email|address|current|former|$)/i,
		)?.[1] || '',
		String(text || '').match(/(?:relatives|related to|family members)\s*:?\s*(.+?)(?:phone|email|address|current|former|$)/i)?.[1] || '',
	].filter(Boolean);

	const excluded = [
		[searchParams.firstName, searchParams.middleName, searchParams.lastName].filter(Boolean).join(' '),
		...((searchParams.aliases || []).map((alias) => [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' ')) || []),
	];

	return [...new Set(sections.flatMap((section) => extractEvidenceNames(section, excluded)))];
}

function inferPrimaryNameFromEvidence(text = '', searchParams = {}) {
	if (searchParams.firstName || searchParams.lastName) {
		return {
			firstName: searchParams.firstName || '',
			middleName: searchParams.middleName || '',
			lastName: searchParams.lastName || '',
		};
	}

	const inferred = extractEvidenceNames(text)[0] || '';
	return splitLooseFullName(inferred);
}

function matchesRequestedLocation(text = '', searchParams = {}) {
	const haystack = normalizeText(text);
	const addressTokens = normalizeText(searchParams.address)
		.split(/\s+/)
		.filter((token) => token.length > 2);
	const matchedAddressTokens = addressTokens.filter((token) => haystack.includes(token)).length;
	const hasAddressMatch = addressTokens.length ? matchedAddressTokens >= Math.min(2, addressTokens.length) : false;
	const hasCityMatch = searchParams.city ? haystack.includes(normalizeText(searchParams.city)) : false;
	const hasStateMatch = searchParams.state ? haystack.includes(normalizeText(searchParams.state)) : false;

	if (searchParams.address) {
		return hasAddressMatch || (hasCityMatch && hasStateMatch);
	}

	return hasCityMatch && hasStateMatch;
}

function fromWebResultEvidence(result = {}, source, searchParams = {}) {
	const evidenceText = [result.title, result.snippet, result.contentPreview, result.content].filter(Boolean).join('\n');
	const entities = sanitizeDocEntities(combineEntities(result.entities, extractEntitiesFromText(evidenceText)));
	const primaryAddress = splitAddress(entities.addresses?.[0] || '');
	const locationHint = extractLocationHint(evidenceText, searchParams);
	const ageDetails = extractAgeDetails(evidenceText);
	const inferredName = inferPrimaryNameFromEvidence(evidenceText, searchParams);
	const locationMatches = matchesRequestedLocation(evidenceText, searchParams);
	const occupantNames =
		locationMatches ?
			extractOccupantNames(evidenceText, {
				...searchParams,
				firstName: searchParams.firstName || inferredName.firstName,
				middleName: searchParams.middleName || inferredName.middleName,
				lastName: searchParams.lastName || inferredName.lastName,
			})
		:	[];

	return createPersonProfile({
		firstName: searchParams.firstName || inferredName.firstName || '',
		middleName: searchParams.middleName || inferredName.middleName || '',
		lastName: searchParams.lastName || inferredName.lastName || '',
		age: ageDetails.age || 0,
		ageText: ageDetails.ageText || '',
		phoneNumbers: entities.phones || [],
		email: entities.emails?.[0] || '',
		address: primaryAddress.address || entities.addresses?.[0] || (locationMatches ? searchParams.address : '') || '',
		city: primaryAddress.city || locationHint.city || (locationMatches ? searchParams.city : '') || '',
		state: primaryAddress.state || locationHint.state || (locationMatches ? searchParams.state : '') || '',
		zipCode: primaryAddress.zipCode || locationHint.zipCode || (locationMatches ? searchParams.zipCode : '') || '',
		county: primaryAddress.county || locationHint.county || '',
		formerAddresses: entities.addresses?.slice(1) || [],
		otherNamesAtAddress: occupantNames,
		relatives: occupantNames,
		website: result.url || '',
		sources: [source || 'web search'],
		sourceUrls: result.url ? { [source || 'web search']: result.url } : {},
	});
}

function normalizeText(value = '') {
	return String(value || '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function getNameVariants(value = '') {
	const base = normalizeText(value).replace(/\s+/g, '');
	if (!base) return [];

	return [
		...new Set(
			[
				base,
				base.replace(/ph/g, 'f'),
				base.replace(/f/g, 'ph'),
				base.endsWith('y') ? `${base.slice(0, -1)}ie` : '',
				base.endsWith('ie') ? `${base.slice(0, -2)}y` : '',
				base.startsWith('j') ? `g${base.slice(1)}` : '',
				base.startsWith('g') ? `j${base.slice(1)}` : '',
			].filter(Boolean),
		),
	];
}

function hasStrongNameEvidence(text = '', searchParams = {}) {
	const haystack = normalizeText(text);
	if (!haystack) return false;

	const firstVariants = getNameVariants(searchParams.firstName);
	const lastVariants = getNameVariants(searchParams.lastName);
	const middle = normalizeText(searchParams.middleName).replace(/\s+/g, '');

	if (!firstVariants.length && !lastVariants.length) {
		return searchParams.address ? matchesRequestedLocation(text, searchParams) : Boolean(haystack);
	}

	const hasFirst = !firstVariants.length || firstVariants.some((variant) => haystack.includes(variant));
	const hasLast = !lastVariants.length || lastVariants.some((variant) => haystack.includes(variant));
	const hasMiddle = !middle || haystack.includes(middle) || haystack.split(/\s+/).includes(middle.charAt(0));

	return hasFirst && hasLast && hasMiddle;
}

function sanitizeDocEntities(entities = {}) {
	return {
		phones: [...new Set((entities.phones || []).filter(Boolean))].slice(0, 5),
		emails: [...new Set((entities.emails || []).filter(Boolean))].slice(0, 3),
		addresses: [...new Set((entities.addresses || []).filter(Boolean))].slice(0, 3),
	};
}

function arraysOverlap(left = [], right = []) {
	const rightSet = new Set(right.map((value) => normalizeText(value)).filter(Boolean));
	return left.some((value) => rightSet.has(normalizeText(value)));
}

const COMMON_FIRST_NAME_GROUPS = [
	['william', 'bill', 'billy', 'will', 'willy'],
	['robert', 'rob', 'bob', 'bobby', 'robbie'],
	['james', 'jim', 'jimmy', 'jamie'],
	['john', 'jon', 'jonathan', 'jonathon', 'johnny'],
	['michael', 'mike', 'mikey'],
	['jennifer', 'jenifer', 'jenn', 'jen', 'jenny', 'jennie', 'jenni'],
];

function getExpandedFirstNameVariants(value = '') {
	const base = normalizeText(value).replace(/\s+/g, '');
	if (!base) return [];

	const variants = new Set(getNameVariants(value));
	variants.add(base);

	for (const group of COMMON_FIRST_NAME_GROUPS) {
		if (group.includes(base)) {
			group.forEach((entry) => variants.add(entry));
		}
	}

	return [...variants].filter(Boolean);
}

function getProfileNameCandidates(profile = {}) {
	const candidates = [
		[profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' '),
		[profile.firstName, profile.lastName].filter(Boolean).join(' '),
		...(profile.aliases || []).map((alias) => (typeof alias === 'string' ? alias : [alias.firstName, alias.middleName, alias.lastName].filter(Boolean).join(' '))),
	];

	return [...new Set(candidates.map((value) => normalizeText(value)).filter(Boolean))];
}

function profileNamesOverlap(existing = {}, candidate = {}) {
	const existingNames = getProfileNameCandidates(existing);
	const candidateNames = getProfileNameCandidates(candidate);

	return existingNames.some((left) =>
		candidateNames.some((right) => {
			if (left === right) return true;

			const leftParts = left.split(/\s+/).filter(Boolean);
			const rightParts = right.split(/\s+/).filter(Boolean);
			const leftFirst = leftParts[0] || '';
			const rightFirst = rightParts[0] || '';
			const leftLast = leftParts.at(-1) || '';
			const rightLast = rightParts.at(-1) || '';

			if (!leftFirst || !rightFirst || !leftLast || !rightLast) return false;
			if (leftLast !== rightLast) return false;

			const leftVariants = getExpandedFirstNameVariants(leftFirst);
			const rightVariants = getExpandedFirstNameVariants(rightFirst);
			return leftVariants.some((variant) => rightVariants.includes(variant));
		}),
	);
}

function hasLocationEvidence(profile = {}) {
	return Boolean(normalizeText(profile.address) || (normalizeText(profile.city) && normalizeText(profile.state)));
}

function hasConflictingLocation(existing = {}, candidate = {}) {
	const existingAddress = normalizeText(existing.address);
	const candidateAddress = normalizeText(candidate.address);

	if (existingAddress && candidateAddress && existingAddress !== candidateAddress) {
		return true;
	}

	const existingCityState = [normalizeText(existing.city), normalizeText(existing.state)].filter(Boolean).join(' ');
	const candidateCityState = [normalizeText(candidate.city), normalizeText(candidate.state)].filter(Boolean).join(' ');

	return Boolean(existingCityState && candidateCityState && existingCityState !== candidateCityState);
}

function hasAgeEvidence(profile = {}) {
	return Boolean(profile.age || normalizeText(profile.ageText || ''));
}

function isWeakThatsthemShell(profile = {}) {
	const normalizedSources = [...new Set((profile.sources || []).map((source) => normalizeText(source)))].filter(Boolean);

	if (!normalizedSources.length) return false;
	if (normalizedSources.some((source) => source !== 'thatsthem')) return false;

	return !hasAgeEvidence(profile);
}

function profileEvidenceScore(profile = {}) {
	return (
		[profile.address, profile.city, profile.state, profile.zipCode, profile.email, profile.age, profile.ageText, profile.yearsAtAddress].filter(Boolean).length +
		(profile.phoneNumbers?.length || 0) * 2 +
		(profile.aliases?.length || 0) * 2 +
		(profile.relatives?.length || 0) * 2 +
		(profile.otherNamesAtAddress?.length || 0) +
		(profile.formerAddresses?.length || 0) +
		(profile.website ? 1 : 0)
	);
}

function getExactNamedAddressKey(profile = {}) {
	const name = normalizeText(
		[profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ') || [profile.firstName, profile.lastName].filter(Boolean).join(' '),
	);
	const address = normalizeText(profile.address || '');

	if (!name || !address) return '';

	return [name, address, normalizeText(profile.city || ''), normalizeText(profile.state || '')].join('|');
}

function pruneWeakDuplicateProfiles(profiles = []) {
	const kept = [];

	for (const profile of profiles) {
		const existingIndex = kept.findIndex((entry) => profileNamesOverlap(entry, profile) && !hasConflictingLocation(entry, profile));

		if (existingIndex === -1) {
			kept.push(profile);
			continue;
		}

		const current = kept[existingIndex];
		const currentScore = profileEvidenceScore(current);
		const incomingScore = profileEvidenceScore(profile);

		kept[existingIndex] = incomingScore > currentScore ? mergeProfiles(profile, current) : mergeProfiles(current, profile);
	}

	const mergedExact = [];
	const exactMap = new Map();

	for (const profile of kept) {
		const exactKey = getExactNamedAddressKey(profile);
		if (!exactKey) {
			mergedExact.push(profile);
			continue;
		}

		const existing = exactMap.get(exactKey);
		if (!existing) {
			exactMap.set(exactKey, profile);
			mergedExact.push(profile);
			continue;
		}

		const existingScore = profileEvidenceScore(existing);
		const incomingScore = profileEvidenceScore(profile);
		const merged = incomingScore > existingScore ? mergeProfiles(profile, existing) : mergeProfiles(existing, profile);

		exactMap.set(exactKey, merged);
		const index = mergedExact.indexOf(existing);
		if (index !== -1) {
			mergedExact[index] = merged;
		}
	}

	return mergedExact.filter((profile) => {
		if (isWeakThatsthemShell(profile)) {
			return false;
		}

		const exactKey = getExactNamedAddressKey(profile);
		if (!exactKey) return true;
		if (hasAgeEvidence(profile)) return true;
		return false;
	});
}

function hasAnyMeaningfulData(profile) {
	return Boolean(
		profile.firstName ||
		profile.lastName ||
		profile.address ||
		profile.city ||
		profile.state ||
		profile.email ||
		profile.phoneNumbers?.length ||
		profile.otherNamesAtAddress?.length ||
		profile.relatives?.length ||
		profile.aliases?.length ||
		profile.formerAddresses?.length ||
		profile.website,
	);
}

function shouldMergeProfiles(existing, candidate) {
	const existingName = [existing.firstName, existing.middleName, existing.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const candidateName = [candidate.firstName, candidate.middleName, candidate.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const existingBaseName = [existing.firstName, existing.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const candidateBaseName = [candidate.firstName, candidate.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const compatibleName =
		(existingBaseName && candidateBaseName && existingBaseName === candidateBaseName) ||
		(existingName && candidateName && existingName === candidateName) ||
		profileNamesOverlap(existing, candidate);

	if ((existingName || existingBaseName) && (candidateName || candidateBaseName) && !compatibleName) {
		return false;
	}

	const existingAddress = normalizeText(existing.address);
	const candidateAddress = normalizeText(candidate.address);
	const sameAddress = existingAddress && candidateAddress && (existingAddress.includes(candidateAddress) || candidateAddress.includes(existingAddress));

	const sameCityState =
		normalizeText(existing.city) && normalizeText(existing.city) === normalizeText(candidate.city) && normalizeText(existing.state) === normalizeText(candidate.state);

	const sameAge = existing.age && candidate.age && Math.abs(Number(existing.age) - Number(candidate.age)) <= 1;

	const sameEmail = normalizeText(existing.email) && normalizeText(existing.email) === normalizeText(candidate.email);
	const sharedPhones = arraysOverlap(existing.phoneNumbers || [], candidate.phoneNumbers || []);
	const weakThatsthemPair = isWeakThatsthemShell(existing) || isWeakThatsthemShell(candidate);

	if (weakThatsthemPair && !sameAddress && !sameCityState && !sameEmail && !sharedPhones) {
		return false;
	}

	if (compatibleName && hasConflictingLocation(existing, candidate) && !sameEmail && !sharedPhones) {
		return false;
	}

	if (sameEmail || sharedPhones) return true;
	if (sameAddress && (sameCityState || sameAge || compatibleName)) {
		return true;
	}
	if (compatibleName) {
		if (sameCityState || sameAddress || sameEmail || sharedPhones) {
			return true;
		}

		if (!hasLocationEvidence(existing) || !hasLocationEvidence(candidate)) {
			return true;
		}

		if (sameAge && sameCityState) {
			return true;
		}
	}

	return false;
}

function getMergeScore(existing, candidate) {
	if (!shouldMergeProfiles(existing, candidate)) {
		return -1;
	}

	const existingBaseName = [existing.firstName, existing.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const candidateBaseName = [candidate.firstName, candidate.lastName]
		.filter(Boolean)
		.map((value) => normalizeText(value))
		.join(' ');
	const sameAddress =
		normalizeText(existing.address) &&
		normalizeText(candidate.address) &&
		(normalizeText(existing.address).includes(normalizeText(candidate.address)) || normalizeText(candidate.address).includes(normalizeText(existing.address)));
	const sameCityState =
		normalizeText(existing.city) && normalizeText(existing.city) === normalizeText(candidate.city) && normalizeText(existing.state) === normalizeText(candidate.state);
	const sameAge = existing.age && candidate.age && Math.abs(Number(existing.age) - Number(candidate.age)) <= 1;
	const sharedPhones = arraysOverlap(existing.phoneNumbers || [], candidate.phoneNumbers || []);
	const sameEmail = normalizeText(existing.email) && normalizeText(existing.email) === normalizeText(candidate.email);

	return (
		(sameEmail ? 8 : 0) +
		(sharedPhones ? 7 : 0) +
		(sameAddress ? 6 : 0) +
		(sameCityState ? 5 : 0) +
		(sameAge ? 2 : 0) +
		(existingBaseName && existingBaseName === candidateBaseName ? 2 : 0)
	);
}

function scoreProfile(profile) {
	return profileEvidenceScore(profile) + (profile.sources?.length || 0);
}

function hasSearchedName(searchParams = {}) {
	return Boolean(String(searchParams.firstName || '').trim() && String(searchParams.lastName || '').trim());
}

/**
 * Main aggregation function.
 *
 * @param {object} searchParams  - original user search params
 * @param {object[]} engineResults   - from runAllSearchEngines()
 * @param {object[]} directoryResults - from runAllDirectorySearches()
 * @returns {PersonProfile[]}
 */
export async function buildProfiles(searchParams, engineResults, directoryResults) {
	if (!hasSearchedName(searchParams)) {
		logger.debug('Skipping profile aggregation because no searched name was provided', {
			searchTerm: searchParams.searchTerm,
			address: searchParams.address,
			sourceUrl: searchParams.sourceUrl,
		});
		return [];
	}

	const candidateProfiles = [];

	try {
		loadMLSData();
	} catch {
		logger.debug('MLS data unavailable for automatic address matching');
	}

	// ── 1. Incorporate directory results as distinct candidates ──────────────
	for (const { source, profiles } of directoryResults) {
		for (const raw of profiles) {
			const profile = fromDirectory(raw, source);
			if (hasAnyMeaningfulData(profile)) {
				candidateProfiles.push(profile);
			}
		}
	}

	// ── 2. Extract entities from crawled search result pages ─────────────────
	for (const { source, results } of engineResults) {
		for (const result of results) {
			const evidenceText = [result.title, result.content, result.contentPreview, result.snippet].filter(Boolean).join('\n');

			if (!hasStrongNameEvidence(evidenceText, searchParams)) {
				continue;
			}

			const webProfile = fromWebResultEvidence(result, source, searchParams);

			if (webProfile.address || webProfile.age || webProfile.ageText || webProfile.phoneNumbers?.length || webProfile.email || webProfile.formerAddresses?.length) {
				candidateProfiles.push(webProfile);
			}
		}
	}

	// ── 3. Collect document URLs from search engine snippets ─────────────────
	const docUrls = [];
	for (const { results } of engineResults) {
		for (const r of results) {
			const evidenceText = [r.title, r.contentPreview, r.snippet, r.content].filter(Boolean).join('\n');

			if (DOC_EXTENSIONS.test(r.url) && hasStrongNameEvidence(evidenceText, searchParams)) {
				docUrls.push(r.url);
			}
		}
	}

	logger.debug('Document URLs to parse', { count: docUrls.length });

	if (docUrls.length) {
		const docResults = await parseDocuments(docUrls);
		for (const { url, entities } of docResults) {
			const sanitizedEntities = sanitizeDocEntities(entities);
			if (sanitizedEntities.phones.length || sanitizedEntities.emails.length || sanitizedEntities.addresses.length) {
				candidateProfiles.push(fromDocEntities(sanitizedEntities, 'document', searchParams));
			}
		}
	}

	// ── 4. Collect social media / websites from engine results ───────────────
	const socialHints = {};
	const SM_PATTERNS = {
		linkedin: /linkedin\.com\/in\//i,
		twitter: /(?:twitter|x)\.com\//i,
		facebook: /facebook\.com\//i,
		instagram: /instagram\.com\//i,
		youtube: /youtube\.com\//i,
	};

	for (const { results } of engineResults) {
		for (const r of results) {
			for (const [platform, re] of Object.entries(SM_PATTERNS)) {
				if (re.test(r.url) && !socialHints[platform]) {
					socialHints[platform] = r.url;
				}
			}
		}
	}

	// ── 5. Merge only obviously matching fragments ───────────────────────────
	const groupedProfiles = [];

	for (const profile of candidateProfiles) {
		let existingIndex = -1;
		let bestScore = -1;

		groupedProfiles.forEach((current, index) => {
			const score = getMergeScore(current, profile);
			if (score > bestScore) {
				bestScore = score;
				existingIndex = index;
			}
		});

		if (existingIndex === -1) {
			groupedProfiles.push(profile);
		} else {
			groupedProfiles[existingIndex] = mergeProfiles(groupedProfiles[existingIndex], profile);
		}
	}

	const finalized = pruneWeakDuplicateProfiles(
		groupedProfiles
			.map((profile) => {
				let normalized = { ...profile };

				if (!normalized.firstName) normalized.firstName = searchParams.firstName || '';
				if (!normalized.middleName) normalized.middleName = searchParams.middleName || '';
				if (!normalized.lastName) normalized.lastName = searchParams.lastName || '';
				if (!normalized.aliases?.length && searchParams.aliases?.length) {
					normalized.aliases = searchParams.aliases;
				}
				if (!normalized.sources?.length) {
					normalized.sources = ['crawl'];
				}
				if (groupedProfiles.length === 1 && Object.keys(socialHints).length) {
					normalized.socialMedia = {
						...normalized.socialMedia,
						...socialHints,
					};
				}

				normalized = enrichProfileWithMLS(normalized);
				normalized.updatedAt = new Date().toISOString();
				return normalized;
			})
			.filter(hasAnyMeaningfulData),
	).sort((left, right) => scoreProfile(right) - scoreProfile(left));

	if (!finalized.length) {
		const firstEngineHit = engineResults.flatMap((entry) => entry.results || []).find((item) => item.url || item.snippet);

		const engineSources = engineResults.filter((entry) => Array.isArray(entry.results) && entry.results.length).map((entry) => entry.source);

		const fallbackProfile = createPersonProfile({
			firstName: searchParams.firstName || '',
			middleName: searchParams.middleName || '',
			lastName: searchParams.lastName || '',
			address: searchParams.address || '',
			city: searchParams.city || '',
			state: searchParams.state || '',
			aliases: searchParams.aliases || [],
			website: firstEngineHit?.url || '',
			sources: engineSources.length ? engineSources : ['input'],
		});

		if (Object.keys(socialHints).length) {
			fallbackProfile.socialMedia = {
				...fallbackProfile.socialMedia,
				...socialHints,
			};
		}

		if (hasAnyMeaningfulData(fallbackProfile)) {
			finalized.push(fallbackProfile);
		}
	}

	logger.debug('Profiles built', {
		count: finalized.length,
		names: finalized.map((profile) => `${profile.firstName} ${profile.lastName}`.trim()),
	});

	return finalized;
}
