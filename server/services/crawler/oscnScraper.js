/**
 * Minimal OSCN scraper shim.
 */

export const OKLAHOMA_COUNTIES = new Map([
	['Oklahoma', 'oklahoma'],
	['Tulsa', 'tulsa'],
]);

export async function searchOscnByName({ lastName, firstName, county, dobMin, dobMax } = {}) {
	return { results: [], fromCache: true };
}

export async function getOscnCaseDetail(url) {
	return { caseNumber: null, caseType: null, filed: null, closed: null, judge: null, parties: [], docket: [] };
}

export default { OKLAHOMA_COUNTIES, searchOscnByName, getOscnCaseDetail };
