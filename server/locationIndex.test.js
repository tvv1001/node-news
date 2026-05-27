import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalizeLocation, isKnownCityName, searchLocations } from './utils/locationIndex.js';

test('location helpers stay safe when the optional city-state dataset is missing', () => {
	assert.doesNotThrow(() => canonicalizeLocation({ city: 'Austin', state: 'TX' }));
	assert.deepEqual(canonicalizeLocation({ city: 'Austin', state: 'TX' }), {
		city: 'Austin',
		state: 'TX',
		stateName: 'Texas',
		known: false,
	});
	assert.equal(isKnownCityName('Austin'), false);
	assert.deepEqual(searchLocations('Austin'), []);
});
