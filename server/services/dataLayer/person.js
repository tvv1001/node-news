import { v4 as uuidv4 } from 'uuid';
import { inferLocationByAddress, inferLocationByZip, isKnownCityName } from '../../utils/locationIndex.js';

const NON_PERSON_RELATIVE_PATTERNS = [
	/\bdoes\s+[a-z]+\s+[a-z]+\b/i,
	/\bis\s+[a-z]+\s+[a-z]+\b/i,
	/\bcourt records?\b/i,
	/\bcriminal records?\b/i,
	/\btraffic violations?\b/i,
	/\bfair credit reporting\b/i,
	/\brecord date\b/i,
	/\bcase type\b/i,
	/\boffense date\b/i,
	/\boffense code\b/i,
	/\boffense desc\b/i,
	/\bdisposition date\b/i,
	/\bbusiness records?\b/i,
	/\b(email|phone) lookup\b/i,
	/\bwhite pages directory\b/i,
	/\bcontact info\b/i,
	/\bwork history\b/i,
	/\beducation history\b/i,
	/\bdemographic info\b/i,
	/\bfor business\b/i,
	/\bsign up\b/i,
	/\bget help\b/i,
	/\bbrowse locations\b/i,
	/\bjob positions\b/i,
	/\bthe new york\b/i,
	/\bcase no\b/i,
	/\bfind phone number\b/i,
	/\bstatistics\b/i,
	/\bshowing\b/i,
	/\bknown\b/i,
	/\btitle\b/i,
	/\bsummary\b/i,
	/\bsearch results?\b/i,
	/\bpeople search\b/i,
	/\bapple color emoji\b/i,
	/\bsegoe ui(?: emoji)?\b/i,
];

const NON_PERSON_RELATIVE_WORDS = new Set([
	'records',
	'record',
	'court',
	'criminal',
	'traffic',
	'terms',
	'fair',
	'credit',
	'reporting',
	'business',
	'company',
	'staff',
	'engineer',
	'quality',
	'therapeutics',
	'inc',
	'therapist',
	'clinical',
	'supervisor',
	'author',
	'motivational',
	'demographic',
	'email',
	'lookup',
	'phone',
	'directory',
	'logo',
	'sign',
	'help',
	'states',
	'browse',
	'locations',
	'history',
	'contact',
	'school',
	'university',
	'college',
	'marketing',
	'strategy',
	'positions',
	'assistant',
	'district',
	'attorney',
	'manager',
	'resources',
	'physician',
	'liaison',
	'county',
	'statistics',
	'pages',
	'summary',
	'known',
	'title',
	'showing',
	'info',
	'experienced',
	'systems',
	'find',
	'well',
	'lockheed',
	'navy',
	'food',
	'sales',
	'bank',
	'united',
	'new',
	'north',
	'south',
	'west',
	'hampshire',
	'jersey',
	'mexico',
	'york',
	'carolina',
	'dakota',
	'virginia',
	'search',
	'results',
	'people',
	'emoji',
	'segoe',
	'apple',
	'st',
	'street',
	'rd',
	'road',
	'ave',
	'avenue',
	'dr',
	'drive',
	'blvd',
	'boulevard',
	'ct',
	'court',
	'ln',
	'lane',
	'way',
	'hwy',
	'highway',
	'cir',
	'circle',
	'pkwy',
	'parkway',
	'pl',
	'place',
	'ter',
	'terrace',
	'trl',
	'trail',
	'n',
	's',
	'e',
	'w',
	'ne',
	'nw',
	'se',
	'sw',
]);

const STREET_OR_PLACE_RE =
	/(?:(?:^|\s)(?:p\.?\s*o\.?\s*box|box)|(?:^|\s)(?:[A-Za-z0-9'.-]+\s+){0,4}(?:st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|ct|court|ln|lane|way|hwy|highway|cir|circle|pkwy|parkway|pl|place|ter|terrace|trl|trail)(?:\s+(?:n|s|e|w|ne|nw|se|sw))?)\.?$/i;
const PLACE_LIKE_PREFIX_RE = /^(?:saint|sainte|san|fort|old|rancho|spokane|seaside|wake|johnson|junction|corpus|broken|apple|oak|gold|league|du)\s+/i;
const PLACE_LIKE_ENDING_RE = /\b(?:valley|heights|beach|harbor|city|falls|forest|genevieve|quoin|verdes|christi|daisy|stewart)\b$/i;
const STREET_ADDRESS_RE =
	/\b(?:p\.?\s*o\.?\s*box|box|st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|ct|court|ln|lane|way|hwy|highway|cir|circle|pkwy|parkway|pl|place|ter|terrace|trl|trail)\.?$/i;
const ZIP_LEADING_STREET_RE =
	/^(\d{5}(?:-\d{4})?)\s+(.+?\b(?:p\.?\s*o\.?\s*box|box|st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|ct|court|ln|lane|way|hwy|highway|cir|circle|pkwy|parkway|pl|place|ter|terrace|trl|trail))\.?$/i;
const TRAILING_ZIP_STREET_RE =
	/^(.+?\b(?:p\.?\s*o\.?\s*box|box|st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|ct|court|ln|lane|way|hwy|highway|cir|circle|pkwy|parkway|pl|place|ter|terrace|trl|trail))\.?\s*,?\s*(\d{5}(?:-\d{4})?)$/i;
const CITY_STATE_RE = /^([A-Za-z .'-]+?)(?:,\s*|\s+)([A-Z]{2})$/;

const ADDRESS_FRAGMENT_RE =
	/(?:^|\s)(?:n|s|e|w|ne|nw|se|sw)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:St|Street|Rd|Road|Ave|Avenue|Dr|Drive|Blvd|Boulevard|Ct|Court|Ln|Lane|Way|Hwy|Highway)\.?$/i;
const TRAILING_UI_NAME_SUFFIX_RE = /(\b[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){1,3}?)(?:Get|View|More|Info|Details|Profile|Report|Records|Search|Results)$/;

function normalizeDisplayText(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.replace(/[.,/|:;]+$/g, '')
		.trim();
}

function cleanPersonDisplayName(value = '') {
	let cleaned = normalizeDisplayText(value)
		.replace(/\b(?:Get|View|More|Info|Details|Profile|Report|Records|Search|Results)\b.*$/i, '')
		.trim();

	const gluedMatch = cleaned.match(TRAILING_UI_NAME_SUFFIX_RE);
	if (gluedMatch) {
		cleaned = normalizeDisplayText(gluedMatch[1]);
	}

	return cleaned;
}

function normalizeIdentityValue(value = '') {
	return normalizeDisplayText(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function sanitizePhoneNumbers(phoneNumbers = []) {
	const TOLL_FREE_PREFIXES = new Set(['800', '833', '844', '855', '866', '877', '888']);

	return [
		...new Set(
			(phoneNumbers || [])
				.map((value) => normalizeDisplayText(String(value)))
				.filter(Boolean)
				.filter((value) => {
					const digits = value.replace(/\D/g, '');
					const core = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
					if (core.length !== 10) return false;
					if (TOLL_FREE_PREFIXES.has(core.slice(0, 3))) return false;
					return true;
				}),
		),
	].slice(0, 5);
}

function haveSharedPhones(existing = {}, incoming = {}) {
	const existingPhones = new Set((existing.phoneNumbers || []).map((phone) => normalizeIdentityValue(phone)));

	return (incoming.phoneNumbers || []).some((phone) => existingPhones.has(normalizeIdentityValue(phone)));
}

function shouldCombineRelativeLists(existing = {}, incoming = {}) {
	const existingAddress = normalizeIdentityValue([existing.address, existing.city, existing.state, existing.zipCode].filter(Boolean).join(' '));
	const incomingAddress = normalizeIdentityValue([incoming.address, incoming.city, incoming.state, incoming.zipCode].filter(Boolean).join(' '));
	const sameAddress = existingAddress && incomingAddress && (existingAddress.includes(incomingAddress) || incomingAddress.includes(existingAddress));
	const sameAge = existing.age && incoming.age && Math.abs(Number(existing.age) - Number(incoming.age)) <= 1;
	const sameEmail = normalizeIdentityValue(existing.email) && normalizeIdentityValue(existing.email) === normalizeIdentityValue(incoming.email);

	return Boolean(sameEmail || haveSharedPhones(existing, incoming) || (sameAddress && sameAge));
}

function looksLikeStreetOrPlace(value = '') {
	const cleaned = normalizeDisplayText(value);
	if (!cleaned) return false;
	if (STREET_OR_PLACE_RE.test(cleaned)) return true;
	if (PLACE_LIKE_PREFIX_RE.test(cleaned)) return true;
	if (PLACE_LIKE_ENDING_RE.test(cleaned) && cleaned.split(/\s+/).filter(Boolean).length <= 4) {
		return true;
	}
	if (/^[A-Z][A-Za-z'.-]+\s+(?:Jr|Sr|II|III|IV)\.?$/i.test(cleaned)) {
		return true;
	}
	return isKnownCityName(cleaned);
}

function isStreetAddressLike(value = '') {
	const cleaned = normalizeDisplayText(value);
	return Boolean(cleaned && (STREET_ADDRESS_RE.test(cleaned) || ZIP_LEADING_STREET_RE.test(cleaned) || TRAILING_ZIP_STREET_RE.test(cleaned)));
}

function looksLikeCityStateValue(value = '') {
	const cleaned = normalizeDisplayText(value);
	if (!cleaned || isStreetAddressLike(cleaned)) return false;
	if (CITY_STATE_RE.test(cleaned)) return true;
	if (isKnownCityName(cleaned)) return true;
	return /^[A-Z][A-Za-z'.-]+(?:\s+[A-Z][A-Za-z'.-]+){0,3}$/.test(cleaned);
}

function normalizeZipCodeValue(value = '') {
	return String(value || '').match(/\d{5}(?:-\d{4})?/)?.[0] || '';
}

function normalizeCountyValue(value = '') {
	const cleaned = normalizeDisplayText(String(value || '').replace(/\bcounty\b/i, ''));
	return cleaned ? `${cleaned} County` : '';
}

function normalizeStructuredAddress(profile = {}) {
	const cleanedAddress = normalizeDisplayText(profile.address || '');
	const embeddedMatch = cleanedAddress.match(
		/^(.*?\b(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Court|Ct|Place|Pl|Trail|Trl|Highway|Hwy))\.?\s*,?\s*([A-Za-z .'-]+?)\s*,\s*([A-Z]{2})(?:\s*,?\s*(\d{5}(?:-\d{4})?))?(?:\s*,?\s*([A-Za-z .'-]+\s+County))?$/i,
	);
	const address = normalizeDisplayText(embeddedMatch?.[1] || cleanedAddress);
	const inferredFromAddress = inferLocationByAddress(address || cleanedAddress);
	const zipCode = normalizeZipCodeValue(profile.zipCode || embeddedMatch?.[4] || inferredFromAddress.zipCode || '');
	const inferred = inferLocationByZip(
		zipCode,
		profile.state || embeddedMatch?.[3] || inferredFromAddress.state || '',
		profile.city || embeddedMatch?.[2] || inferredFromAddress.city || '',
	);

	return {
		address,
		city: normalizeDisplayText(profile.city || embeddedMatch?.[2] || inferredFromAddress.city || inferred.city || ''),
		state: normalizeDisplayText(profile.state || embeddedMatch?.[3] || inferredFromAddress.state || inferred.state || ''),
		zipCode,
		county: normalizeCountyValue(profile.county || embeddedMatch?.[5] || inferredFromAddress.county || inferred.county || ''),
	};
}

function formatFormerAddress(value = '', cityHint = '', stateHint = '', profile = {}) {
	const cleaned = normalizeDisplayText(value);
	if (!cleaned) return '';

	const zipLeadingMatch = cleaned.match(ZIP_LEADING_STREET_RE);
	const trailingZipMatch = cleaned.match(TRAILING_ZIP_STREET_RE);
	const inferredFromAddress = inferLocationByAddress(cleaned);
	const zipCode = normalizeZipCodeValue(zipLeadingMatch?.[1] || trailingZipMatch?.[2] || inferredFromAddress.zipCode || '');
	const address = normalizeDisplayText(zipLeadingMatch?.[2] || trailingZipMatch?.[1] || cleaned);
	const inferred = inferLocationByZip(zipCode, stateHint || inferredFromAddress.state || profile.state || '', cityHint || inferredFromAddress.city || profile.city || '');
	const resolvedCity = normalizeDisplayText(cityHint || inferredFromAddress.city || inferred.city || profile.city || '');
	const resolvedState = normalizeDisplayText(stateHint || inferredFromAddress.state || inferred.state || profile.state || '');
	const resolvedCounty = normalizeCountyValue(inferredFromAddress.county || inferred.county || profile.county || '');

	return [address, resolvedCity, resolvedState, zipCode, resolvedCounty].filter(Boolean).join(', ');
}

/**
 * If a non-street former address entry has noise or a person-name prefix before
 * a trailing "City, ST" pattern, strip the prefix and return just "City, ST".
 * Returns null when the value has no recognisable city+state.
 */
function trimNoisyFormerAddress(value = '') {
	const s = normalizeDisplayText(value);
	const commaIdx = s.lastIndexOf(',');
	if (commaIdx < 0) return null;
	const state = s.slice(commaIdx + 1).trim();
	if (!/^[A-Z]{2}$/.test(state)) return null;
	const beforeState = s.slice(0, commaIdx).trim();
	const words = beforeState.split(/\s+/);
	// Try longest-to-shortest suffix (up to 3 words) to find a known city.
	// Longest-first preserves multi-word cities like "New York" while still
	// trimming prepended name/noise words.
	const maxTry = Math.min(3, words.length);
	for (let n = maxTry; n >= 1; n -= 1) {
		const candidateCity = words.slice(-n).join(' ');
		if (isKnownCityName(candidateCity)) {
			const trimmed = `${candidateCity}, ${state}`;
			// Only return the trimmed version when something was actually stripped
			return trimmed !== s ? trimmed : s;
		}
	}
	// No known city — leave the entry as-is for fallback rendering
	return s;
}

/**
 * Scan raw former-address strings for patterns like
 * "[Name Words] [City, ST]" and return any name-like prefixes found.
 * Used to populate otherNamesAtAddress with co-residents scraped alongside
 * address history entries.
 */
function extractNamesFromFormerAddresses(formerAddresses = []) {
	const ADDR_NOISE = /^(?:More|View|Details?|See|Profile|Report|Search|Results?|Info|Summary|All|Full|And|The)$/i;
	return formerAddresses.flatMap((entry) => {
		const s = normalizeDisplayText(entry);
		const commaIdx = s.lastIndexOf(',');
		if (commaIdx < 0) return [];
		const state = s.slice(commaIdx + 1).trim();
		if (!/^[A-Z]{2}$/.test(state)) return [];
		const beforeState = s.slice(0, commaIdx).trim();
		const words = beforeState.split(/\s+/);
		if (words.length <= 3) return []; // Just a city, no name prefix
		// Find the city suffix length
		let cityLen = 0;
		for (let n = 1; n <= Math.min(3, words.length - 1); n += 1) {
			if (isKnownCityName(words.slice(-n).join(' '))) {
				cityLen = n;
				break;
			}
		}
		if (cityLen === 0 || cityLen >= words.length) return [];
		const prefix = words.slice(0, words.length - cityLen).join(' ');
		const prefixWords = prefix.split(/\s+/);
		// Person name: 2–4 title-case words, no known noise tokens
		if (prefixWords.length < 2 || prefixWords.length > 4) return [];
		if (prefixWords.some((w) => ADDR_NOISE.test(w))) return [];
		if (!prefixWords.every((w) => /^[A-Z][A-Za-z.'\-]*$/.test(w))) return [];
		return [prefix];
	});
}

function normalizeFormerAddresses(formerAddresses = [], profile = {}) {
	const entries = (formerAddresses || []).map((entry) => normalizeDisplayText(entry)).filter(Boolean);

	const normalized = [];

	for (let index = 0; index < entries.length; index += 1) {
		const current = entries[index];

		if (isStreetAddressLike(current)) {
			const next = entries[index + 1] || '';
			let cityHint = '';
			let stateHint = '';

			if (looksLikeCityStateValue(next)) {
				const cityStateMatch = normalizeDisplayText(next).match(CITY_STATE_RE);
				if (cityStateMatch) {
					cityHint = cityStateMatch[1];
					stateHint = cityStateMatch[2];
				} else {
					cityHint = next;
					stateHint = '';
				}
				index += 1;
			}

			normalized.push(formatFormerAddress(current, cityHint, cityHint ? stateHint || profile.state || '' : profile.state || '', profile));
			continue;
		}

		// Not street-like — trim any noise/name prefix, keep just the city+state
		const trimmed = trimNoisyFormerAddress(current);
		normalized.push(trimmed !== null ? trimmed : current);
	}

	return [...new Set(normalized.filter(Boolean))];
}

function sanitizeRelatives(relatives = [], profile = {}) {
	const targetFullName = normalizeDisplayText([profile.firstName, profile.middleName, profile.lastName].filter(Boolean).join(' ')).toLowerCase();
	const targetFirstName = normalizeDisplayText(profile.firstName).toLowerCase();
	const targetLastName = normalizeDisplayText(profile.lastName).toLowerCase();

	return [
		...new Set(
			(relatives || [])
				.map((value) => cleanPersonDisplayName(String(value)))
				.filter(Boolean)
				.filter((value) => !/\d/.test(value))
				.filter((value) => !NON_PERSON_RELATIVE_PATTERNS.some((pattern) => pattern.test(value)))
				.filter((value) => !ADDRESS_FRAGMENT_RE.test(value))
				.filter((value) => !looksLikeStreetOrPlace(value))
				.filter((value) => !value.includes("'s"))
				.filter((value) => !/[.:]/.test(value))
				.filter((value) => value.toLowerCase() !== targetFullName)
				.filter((value) => !targetFullName || !value.toLowerCase().includes(targetFullName))
				.filter((value) => {
					const parts = normalizeDisplayText(value).toLowerCase().split(/\s+/).filter(Boolean);

					if (parts.length < 2) return false;

					const sameFirstAndLast = targetFirstName && targetLastName && parts[0] === targetFirstName && parts[parts.length - 1] === targetLastName;

					return !sameFirstAndLast;
				})
				.filter((value) => /^[A-Z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*){1,3}$/.test(value))
				.filter((value) => {
					const words = value.split(/\s+/).filter(Boolean);
					return words.length >= 2 && words.length <= 4 && !words.some((word) => NON_PERSON_RELATIVE_WORDS.has(word.toLowerCase()));
				}),
		),
	];
}

export function sanitizeProfile(profile = {}) {
	const cleaned = { ...profile };
	Object.assign(cleaned, normalizeStructuredAddress(cleaned));
	cleaned.phoneNumbers = sanitizePhoneNumbers(cleaned.phoneNumbers || []);
	cleaned.relatives = sanitizeRelatives(cleaned.relatives || [], cleaned);
	cleaned.potentialOccupants = sanitizeRelatives(cleaned.potentialOccupants || cleaned.otherNamesAtAddress || [], cleaned);
	cleaned.neighbors = sanitizeRelatives(cleaned.neighbors || [], cleaned);
	// Extract person names embedded before city+state in raw former addresses
	// (e.g. "Brad Oplinger Atlanta, GA" → alias "Brad Oplinger" + address "Atlanta, GA")
	const embeddedFormerAddressNames = extractNamesFromFormerAddresses(cleaned.formerAddresses || []);
	cleaned.otherNamesAtAddress = sanitizeRelatives([...(cleaned.otherNamesAtAddress || cleaned.relatives || []), ...embeddedFormerAddressNames], cleaned);
	cleaned.formerAddresses = normalizeFormerAddresses(cleaned.formerAddresses || [], cleaned);
	return cleaned;
}

/**
 * Creates a blank person profile conforming to the data layer schema.
 * @param {Partial<PersonProfile>} overrides - fields to set on creation
 * @returns {PersonProfile}
 */
export function createPersonProfile(overrides = {}) {
	return sanitizeProfile({
		id: uuidv4(),
		firstName: '',
		middleName: '',
		lastName: '',
		age: 0,
		address: '',
		city: '',
		state: '',
		zipCode: '',
		county: '',
		country: '',
		aliases: [], // [{ firstName, middleName, lastName }]
		phoneNumbers: [], // string[]
		email: '',
		socialMedia: {}, // { platform: handle/url }
		website: '',
		occupation: '',
		company: '',
		mlsNumber: '',
		lastSoldDate: '',
		lastSoldYear: '',
		lastSoldTo: '',
		grantor: '',
		grantee: '',
		court: '',
		caseNumber: '',
		caseType: '',
		offenseDescription: '',
		disposition: '',
		recordDate: '',
		offenseDate: '',
		yearsAtAddress: '',
		potentialOccupants: [], // string[]
		neighbors: [], // string[]
		otherNamesAtAddress: [], // string[]
		relatives: [], // string[] or [{ name, relationship }]
		marriages: [], // [{ spouseName, date }]
		formerAddresses: [], // string[]
		sources: [], // internal tracking of where data came from
		sourceUrls: {}, // { [sourceName]: url } — the page scraped per source
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	});
}

/**
 * Merges new data into an existing profile, deduplicating arrays.
 * @param {PersonProfile} existing
 * @param {Partial<PersonProfile>} incoming
 * @returns {PersonProfile}
 */
export function mergeProfiles(existing, incoming) {
	const merged = { ...existing };

	// Scalar fields — only overwrite if the existing value is empty
	const scalarFields = [
		'firstName',
		'middleName',
		'lastName',
		'age',
		'address',
		'city',
		'state',
		'zipCode',
		'county',
		'country',
		'email',
		'website',
		'occupation',
		'company',
		'mlsNumber',
		'lastSoldDate',
		'lastSoldYear',
		'lastSoldTo',
		'grantor',
		'grantee',
		'court',
		'caseNumber',
		'caseType',
		'offenseDescription',
		'disposition',
		'recordDate',
		'offenseDate',
		'yearsAtAddress',
	];

	for (const field of scalarFields) {
		if (!existing[field] && incoming[field]) {
			merged[field] = incoming[field];
		}
	}

	// Age: keep the more specific (non-zero) value
	if (!existing.age && incoming.age) {
		merged.age = incoming.age;
	}

	// Merge arrays by deduplication
	if (incoming.phoneNumbers?.length) {
		merged.phoneNumbers = [...new Set([...existing.phoneNumbers, ...incoming.phoneNumbers])];
	}
	if (incoming.formerAddresses?.length) {
		merged.formerAddresses = [...new Set([...existing.formerAddresses, ...incoming.formerAddresses])];
	}
	if (incoming.potentialOccupants?.length) {
		merged.potentialOccupants = [...new Set([...(existing.potentialOccupants || []), ...incoming.potentialOccupants])];
	}
	if (incoming.otherNamesAtAddress?.length) {
		merged.otherNamesAtAddress = [...new Set([...(existing.otherNamesAtAddress || []), ...incoming.otherNamesAtAddress])];
	}
	if (incoming.neighbors?.length) {
		merged.neighbors = [...new Set([...(existing.neighbors || []), ...incoming.neighbors])];
	}
	if (incoming.relatives?.length) {
		if (!existing.relatives?.length) {
			merged.relatives = [...new Set(incoming.relatives)];
		} else if (shouldCombineRelativeLists(existing, incoming)) {
			merged.relatives = [...new Set([...existing.relatives, ...incoming.relatives])];
		} else {
			merged.relatives = existing.relatives.length >= incoming.relatives.length ? [...new Set(existing.relatives)] : [...new Set(incoming.relatives)];
		}
	}

	// Merge aliases by full name uniqueness
	if (incoming.aliases?.length) {
		const existingKeys = new Set(existing.aliases.map((a) => `${a.firstName}|${a.middleName}|${a.lastName}`.toLowerCase()));
		for (const alias of incoming.aliases) {
			const key = `${alias.firstName}|${alias.middleName}|${alias.lastName}`.toLowerCase();
			if (!existingKeys.has(key)) {
				merged.aliases.push(alias);
				existingKeys.add(key);
			}
		}
	}

	// Merge marriages by spouse name
	if (incoming.marriages?.length) {
		const existingSpouses = new Set(existing.marriages.map((m) => m.spouseName?.toLowerCase()));
		for (const marriage of incoming.marriages) {
			if (!existingSpouses.has(marriage.spouseName?.toLowerCase())) {
				merged.marriages.push(marriage);
				existingSpouses.add(marriage.spouseName?.toLowerCase());
			}
		}
	}

	// Merge social media handles
	if (incoming.socialMedia && typeof incoming.socialMedia === 'object') {
		merged.socialMedia = { ...existing.socialMedia, ...incoming.socialMedia };
	}

	// Track sources
	if (incoming.sources?.length) {
		merged.sources = [...new Set([...(existing.sources || []), ...incoming.sources])];
	}

	// Merge source URLs
	if (incoming.sourceUrls && typeof incoming.sourceUrls === 'object') {
		merged.sourceUrls = {
			...(existing.sourceUrls || {}),
			...incoming.sourceUrls,
		};
	}

	merged.updatedAt = new Date().toISOString();
	return sanitizeProfile(merged);
}
