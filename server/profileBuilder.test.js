import test from 'node:test';
import assert from 'node:assert/strict';

import { buildProfiles } from './services/crawler/profileBuilder.js';

test("drops unmatched age-less That\'sThem shells while merging matching location cards", async () => {
	const searchParams = {
		firstName: 'Jennifer',
		middleName: 'Lynn',
		lastName: 'Lively',
	};

	const profiles = await buildProfiles(
		searchParams,
		[],
		[
			{
				source: 'whitepages',
				profiles: [
					{
						firstName: 'Jennifer',
						middleName: 'Lynn',
						lastName: 'Lively',
						age: 51,
						address: '123 Main St',
						city: 'Decatur',
						state: 'TN',
						relatives: ['John Lively'],
						website: 'https://whitepages.example/1',
					},
				],
			},
			{
				source: 'thatsthem',
				profiles: [
					{
						firstName: 'Jennifer',
						middleName: 'Lynn',
						lastName: 'Lively',
						age: 0,
						ageText: '',
						address: '',
						city: 'Decatur',
						state: 'TN',
						county: 'Meigs County',
						website: 'https://thatsthem.example/decatur',
					},
					{
						firstName: 'Jennifer',
						middleName: 'Lynn',
						lastName: 'Lively',
						age: 0,
						ageText: '',
						address: '',
						city: 'Princeton',
						state: 'WV',
						website: 'https://thatsthem.example/princeton',
					},
				],
			},
		],
	);

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].city, 'Decatur');
	assert.equal(profiles[0].state, 'TN');
	assert.equal(profiles[0].age, 51);
	assert.ok(profiles[0].sources.includes('whitepages'));
	assert.ok(profiles[0].sources.includes('thatsthem'));
});

test('normalizes noisy 411 address text down to the real city and state', async () => {
	const profiles = await buildProfiles(
		{
			firstName: 'Jennifer',
			middleName: 'Lynn',
			lastName: 'Lively',
		},
		[],
		[
			{
				source: '411',
				profiles: [
					{
						firstName: 'Jennifer',
						middleName: 'Lynn',
						lastName: 'Lively',
						age: 65,
						address: 'More View Details View Details Jennifer B Lively Houston, TX',
						city: '',
						state: '',
						zipCode: '',
						county: '',
						website: 'https://www.411.com/person-search/Jennifer-Lynn+Lively',
					},
				],
			},
		],
	);

	assert.equal(profiles.length, 1);
	assert.equal(profiles[0].age, 65);
	assert.equal(profiles[0].address, '');
	assert.equal(profiles[0].city, 'Houston');
	assert.equal(profiles[0].state, 'TX');
	assert.match(profiles[0].county, /County$/);
});

test('does not build person profiles for generic term-only searches', async () => {
	const profiles = await buildProfiles(
		{
			searchTerm: 'finra fraud',
			firstName: '',
			middleName: '',
			lastName: '',
			address: '',
			sourceUrl: '',
		},
		[
			{
				source: 'duckduckgo',
				results: [
					{
						title: 'FINRA Fraud Alert',
						url: 'https://example.com/finra-fraud-alert',
						snippet: 'Address M Street, NW Email jane@example.org Phone 3015906500',
						content: 'FINRA fraud investigation document. Address M Street, NW. Email jane@example.org. Phone 3015906500.',
					},
				],
			},
		],
		[],
	);

	assert.deepEqual(profiles, []);
});

test('does not build person profiles for address-only searches', async () => {
	const profiles = await buildProfiles(
		{
			searchTerm: '',
			firstName: '',
			middleName: '',
			lastName: '',
			address: '123 Main St Dallas TX',
			sourceUrl: '',
		},
		[
			{
				source: 'google',
				results: [
					{
						title: '123 Main St property details',
						url: 'https://example.com/property/123-main-st',
						snippet: 'Address 123 Main St Dallas TX Phone 2145551212',
						content: 'Address 123 Main St Dallas TX. Resident phone 2145551212.',
					},
				],
			},
		],
		[],
	);

	assert.deepEqual(profiles, []);
});
