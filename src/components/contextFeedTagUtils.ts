export const ALL_NEWS_TAG = 'all-news';

export function normalizeContextTagValue(value = '') {
	return String(value || '')
		.trim()
		.toLowerCase();
}

export function isAllNewsTag(value = '') {
	return normalizeContextTagValue(value) === ALL_NEWS_TAG;
}

export function normalizeContextTagForSync(value = '') {
	const normalized = normalizeContextTagValue(value);
	return normalized && !isAllNewsTag(normalized) ? normalized : '';
}
