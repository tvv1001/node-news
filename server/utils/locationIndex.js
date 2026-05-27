import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STATE_ABBREVIATIONS = {
	'Alabama': 'AL',
	'Alaska': 'AK',
	'Arizona': 'AZ',
	'Arkansas': 'AR',
	'California': 'CA',
	'Colorado': 'CO',
	'Connecticut': 'CT',
	'Delaware': 'DE',
	'Florida': 'FL',
	'Georgia': 'GA',
	'Hawaii': 'HI',
	'Idaho': 'ID',
	'Illinois': 'IL',
	'Indiana': 'IN',
	'Iowa': 'IA',
	'Kansas': 'KS',
	'Kentucky': 'KY',
	'Louisiana': 'LA',
	'Maine': 'ME',
	'Maryland': 'MD',
	'Massachusetts': 'MA',
	'Michigan': 'MI',
	'Minnesota': 'MN',
	'Mississippi': 'MS',
	'Missouri': 'MO',
	'Montana': 'MT',
	'Nebraska': 'NE',
	'Nevada': 'NV',
	'New Hampshire': 'NH',
	'New Jersey': 'NJ',
	'New Mexico': 'NM',
	'New York': 'NY',
	'North Carolina': 'NC',
	'North Dakota': 'ND',
	'Ohio': 'OH',
	'Oklahoma': 'OK',
	'Oregon': 'OR',
	'Pennsylvania': 'PA',
	'Rhode Island': 'RI',
	'South Carolina': 'SC',
	'South Dakota': 'SD',
	'Tennessee': 'TN',
	'Texas': 'TX',
	'Utah': 'UT',
	'Vermont': 'VT',
	'Virginia': 'VA',
	'Washington': 'WA',
	'West Virginia': 'WV',
	'Wisconsin': 'WI',
	'Wyoming': 'WY',
	'District Of Columbia': 'DC',
};

const STATE_NAMES = Object.fromEntries(Object.entries(STATE_ABBREVIATIONS).map(([name, abbr]) => [abbr, name]));

const ZIP_LOCATION_OVERRIDES = {
	27540: { city: 'Holly Springs', state: 'NC', county: 'Wake County' },
	27587: { city: 'Wake Forest', state: 'NC', county: 'Wake County' },
	37849: { city: 'Powell', state: 'TN', county: 'Knox County' },
	38635: { city: 'Holly Springs', state: 'MS', county: 'Marshall County' },
	63031: { city: 'Florissant', state: 'MO', county: 'St. Louis County' },
	74701: { city: 'Durant', state: 'OK', county: 'Bryan County' },
	74702: { city: 'Durant', state: 'OK', county: 'Bryan County' },
	74723: { city: 'Bennington', state: 'OK', county: 'Bryan County' },
	74726: { city: 'Bokchito', state: 'OK', county: 'Bryan County' },
	74729: { city: 'Caddo', state: 'OK', county: 'Bryan County' },
	74730: { city: 'Calera', state: 'OK', county: 'Bryan County' },
	74733: { city: 'Colbert', state: 'OK', county: 'Bryan County' },
	74736: { city: 'Kenefic', state: 'OK', county: 'Bryan County' },
	75034: { city: 'Frisco', state: 'TX' },
	77002: { city: 'Houston', state: 'TX', county: 'Harris County' },
};

const ADDRESS_LOCATION_OVERRIDES = {
	'7209 lyngate blvd': {
		city: 'Powell',
		state: 'TN',
		zipCode: '37849',
		county: 'Knox County',
	},
	'millick st': {
		city: 'Philadelphia',
		state: 'PA',
		zipCode: '19139',
		county: 'Philadelphia County',
	},
};

function normalizeCityStatePair(entry = {}, fallback = {}) {
	return {
		city: String(entry.city || entry.name || fallback.city || '').trim(),
		state: String(entry.state || entry.stateAbbr || fallback.state || '').trim(),
	};
}

function normalizeCityStatePairs(source = []) {
	if (Array.isArray(source)) {
		return source.map((entry) => normalizeCityStatePair(entry)).filter((entry) => entry.city && entry.state);
	}

	if (!source || typeof source !== 'object') {
		return [];
	}

	return Object.entries(source)
		.flatMap(([key, value]) => {
			if (Array.isArray(value)) {
				return value.map((entry) => (typeof entry === 'string' ? { city: entry, state: key } : normalizeCityStatePair(entry, { state: key })));
			}

			if (typeof value === 'string') {
				return [{ city: key, state: value }];
			}

			if (value && typeof value === 'object') {
				return [normalizeCityStatePair(value, { city: key })];
			}

			return [];
		})
		.filter((entry) => entry.city && entry.state);
}

const cityStateDbUrl = new URL('../../public/city-state-db.json', import.meta.url);
const rawCityStatePairs = existsSync(cityStateDbUrl) ? JSON.parse(readFileSync(cityStateDbUrl, 'utf8')) : [];
const cityStatePairs = normalizeCityStatePairs(rawCityStatePairs);

const zipCsvUrl = new URL('../data/us-state-county-zip.csv', import.meta.url);
const zipJsonUrl = new URL('../data/us-state-county-zip.json', import.meta.url);
const zipJsonPath = fileURLToPath(zipJsonUrl);
const rawZipCountyJson = existsSync(zipJsonPath) ? JSON.parse(readFileSync(zipJsonPath, 'utf8')) : null;
const rawZipCountyCsv = rawZipCountyJson ? '' : readFileSync(zipCsvUrl, 'utf8');

function normalizeCountyName(value = '') {
	const cleaned = titleCase(String(value || '').replace(/\s+/g, ' '));
	if (!cleaned) return '';
	if (/\b(?:County|Parish|Borough|Census Area|Municipality|City And Borough|City)\b$/i.test(cleaned) || /^District Of Columbia$/i.test(cleaned)) {
		return cleaned;
	}
	return `${cleaned} County`;
}

function parseZipCountyRows(source = '') {
	if (Array.isArray(source)) {
		return source
			.map((row) => {
				return {
					stateFips: String(row.state_fips || row.stateFips || '').trim(),
					state: String(row.state || '').trim(),
					stateAbbr: String(row.state_abbr || row.stateAbbr || '').trim(),
					zipcode: String(row.zipcode || '').trim(),
					county: normalizeCountyName(row.county || ''),
					city: normalizeCityValue(row.city || ''),
				};
			})
			.filter((row) => /^\d{5}$/.test(row.zipcode));
	}

	return String(source || '')
		.split(/\r?\n/)
		.slice(1)
		.map((line) => line.trim())
		.filter(Boolean)
		.map((line) => {
			const [stateFips, state, stateAbbr, zipcode, county, ...cityParts] = line.split(',');
			return {
				stateFips,
				state,
				stateAbbr,
				zipcode: String(zipcode || '').trim(),
				county: normalizeCountyName(county || ''),
				city: normalizeCityValue(cityParts.join(',') || ''),
			};
		})
		.filter((row) => /^\d{5}$/.test(row.zipcode));
}

const zipCountyRows = parseZipCountyRows(rawZipCountyJson || rawZipCountyCsv);
const ZIP_REFERENCE_LOOKUP = Object.fromEntries(zipCountyRows.map((row) => [row.zipcode, row]));
const CITY_STATE_REFERENCE_LOOKUP = Object.fromEntries(
	zipCountyRows
		.filter((row) => row.city && row.stateAbbr && row.county)
		.map((row) => [`${normalizeCityValue(row.city).toLowerCase()}|${normalizeStateValue(row.stateAbbr)}`, row.county]),
);

function normalizeWhitespace(value = '') {
	return String(value || '')
		.replace(/\s+/g, ' ')
		.trim();
}

function normalizeAddressKey(value = '') {
	return normalizeWhitespace(value)
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

function titleCase(value = '') {
	return normalizeWhitespace(value)
		.split(' ')
		.filter(Boolean)
		.map((part) => {
			if (/^[A-Z]{2}$/.test(part)) return part;
			return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
		})
		.join(' ');
}

export function normalizeStateValue(value = '') {
	const cleaned = normalizeWhitespace(value).replace(/[.]/g, '');
	if (!cleaned) return '';

	const upper = cleaned.toUpperCase();
	if (STATE_NAMES[upper]) return upper;

	const asTitle = titleCase(cleaned);
	return STATE_ABBREVIATIONS[asTitle] || asTitle;
}

export function normalizeCityValue(value = '') {
	return titleCase(value).replace(/\bSt\b/g, 'St.');
}

export function isKnownCityName(value = '') {
	const normalizedCity = normalizeCityValue(value).toLowerCase();
	if (!normalizedCity) return false;

	return cityStatePairs.some((pair) => normalizeCityValue(pair.city).toLowerCase() === normalizedCity);
}

export function canonicalizeLocation({ city = '', state = '' } = {}) {
	const normalizedCity = normalizeCityValue(city);
	const normalizedState = normalizeStateValue(state);
	const normalizedStateName = STATE_NAMES[normalizedState] || titleCase(state);

	const known = cityStatePairs.some((pair) => normalizeCityValue(pair.city).toLowerCase() === normalizedCity.toLowerCase() && normalizeStateValue(pair.state) === normalizedState);

	return {
		city: normalizedCity,
		state: normalizedState,
		stateName: normalizedStateName,
		known,
	};
}

export function locationMatches(locationText = '', city = '', state = '') {
	const haystack = normalizeWhitespace(locationText).toLowerCase();
	if (!haystack) return true;

	const normalizedCity = normalizeCityValue(city).toLowerCase();
	const normalizedState = normalizeStateValue(state);
	const normalizedStateName = (STATE_NAMES[normalizedState] || '').toLowerCase();
	const tokens = new Set(
		haystack
			.replace(/[^a-z0-9]+/g, ' ')
			.split(/\s+/)
			.filter(Boolean),
	);

	const cityMatches = !normalizedCity || haystack.includes(normalizedCity);
	const stateMatches = !normalizedState || tokens.has(normalizedState.toLowerCase()) || (normalizedStateName && haystack.includes(normalizedStateName));

	return cityMatches && stateMatches;
}

export function searchLocations(query = '', limit = 25) {
	const cleaned = normalizeWhitespace(query).toLowerCase();

	const pairs = cityStatePairs.filter((pair) => {
		if (!cleaned) return false;
		const city = normalizeCityValue(pair.city).toLowerCase();
		const stateName = titleCase(pair.state).toLowerCase();
		const stateAbbr = normalizeStateValue(pair.state).toLowerCase();
		return city.includes(cleaned) || stateName.includes(cleaned) || stateAbbr.includes(cleaned);
	});

	return pairs.slice(0, limit).map((pair) => ({
		city: normalizeCityValue(pair.city),
		state: normalizeStateValue(pair.state),
		stateName: titleCase(pair.state),
		label: `${normalizeCityValue(pair.city)}, ${titleCase(pair.state)}`,
	}));
}

export function getKnownStates() {
	return Object.keys(STATE_ABBREVIATIONS).sort();
}

export function inferLocationByAddress(address = '') {
	const key = normalizeAddressKey(address);
	const mapped = ADDRESS_LOCATION_OVERRIDES[key];

	if (!mapped) {
		return {
			city: '',
			state: '',
			stateName: '',
			zipCode: '',
			county: '',
			known: false,
		};
	}

	return {
		city: normalizeCityValue(mapped.city),
		state: normalizeStateValue(mapped.state),
		stateName: STATE_NAMES[normalizeStateValue(mapped.state)] || titleCase(mapped.state),
		zipCode: mapped.zipCode || '',
		county: mapped.county || '',
		known: true,
	};
}

export function inferLocationByZip(zipCode = '', fallbackState = '', fallbackCity = '') {
	const normalizedZip = String(zipCode || '').match(/\d{5}(?:-\d{4})?/)?.[0] || '';
	const fallback = {
		city: normalizeCityValue(fallbackCity),
		state: normalizeStateValue(fallbackState),
		stateName: STATE_NAMES[normalizeStateValue(fallbackState)] || titleCase(fallbackState),
		county: '',
		known: false,
	};

	const cityStateKey = `${fallback.city.toLowerCase()}|${fallback.state}`;
	const cityStateCounty = CITY_STATE_REFERENCE_LOOKUP[cityStateKey] || '';
	const cityStateMapped = Object.values(ZIP_LOCATION_OVERRIDES).find(
		(entry) => normalizeCityValue(entry.city) === fallback.city && normalizeStateValue(entry.state) === fallback.state && entry.county,
	);

	if (!normalizedZip) {
		return cityStateMapped || cityStateCounty ?
				{
					...fallback,
					county: cityStateMapped?.county || cityStateCounty || '',
					known: true,
				}
			:	fallback;
	}

	const override = ZIP_LOCATION_OVERRIDES[normalizedZip.slice(0, 5)];
	const reference = ZIP_REFERENCE_LOOKUP[normalizedZip.slice(0, 5)];

	if (!override && !reference) {
		return cityStateMapped || cityStateCounty ?
				{
					...fallback,
					county: cityStateMapped?.county || cityStateCounty || '',
					known: true,
				}
			:	fallback;
	}

	const resolvedState = normalizeStateValue(override?.state || reference?.stateAbbr || fallback.state);

	return {
		city: normalizeCityValue(override?.city || reference?.city || fallback.city),
		state: resolvedState,
		stateName: STATE_NAMES[resolvedState] || titleCase(resolvedState),
		county: normalizeCountyName(override?.county || reference?.county || cityStateMapped?.county || cityStateCounty || '') || '',
		known: true,
	};
}
