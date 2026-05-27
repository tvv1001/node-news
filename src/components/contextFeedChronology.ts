function parseFeedTimestamp(value = '') {
	const rawValue = String(value || '').trim();
	if (!rawValue) return 0;

	const directTimestamp = Date.parse(rawValue);
	if (!Number.isNaN(directTimestamp)) return directTimestamp;

	const normalizedIsoLikeValue = rawValue.replace(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?)$/, '$1T$2');
	const normalizedTimestamp = Date.parse(normalizedIsoLikeValue);
	return Number.isNaN(normalizedTimestamp) ? 0 : normalizedTimestamp;
}

const FUTURE_DATE_TOLERANCE_MS = 5 * 60 * 1000;

export function isFutureDatedFeedItem(item: any = {}) {
	const publishedTime = parseFeedTimestamp(item?.publishedAt || '');
	if (!publishedTime) return false;

	return publishedTime > Date.now() + FUTURE_DATE_TOLERANCE_MS;
}

export function sortFeedItemsNewestFirst(items: any[] = [], { preferCurrentUpdates = false, getPriority = (item: any) => 0 }: any = {}) {
	return [...items].sort((left, right) => {
		const leftPublishedTime = parseFeedTimestamp(left?.publishedAt || '');
		const rightPublishedTime = parseFeedTimestamp(right?.publishedAt || '');
		const leftHasPublishedTime = leftPublishedTime > 0;
		const rightHasPublishedTime = rightPublishedTime > 0;

		if (leftHasPublishedTime || rightHasPublishedTime) {
			if (leftHasPublishedTime !== rightHasPublishedTime) {
				return Number(rightHasPublishedTime) - Number(leftHasPublishedTime);
			}

			if (rightPublishedTime !== leftPublishedTime) {
				return rightPublishedTime - leftPublishedTime;
			}
		}

		const leftDiscoveredTime = parseFeedTimestamp(left?.discoveredAt || '');
		const rightDiscoveredTime = parseFeedTimestamp(right?.discoveredAt || '');
		if (rightDiscoveredTime !== leftDiscoveredTime) {
			return rightDiscoveredTime - leftDiscoveredTime;
		}

		if (preferCurrentUpdates) {
			const leftPriority = Number(getPriority(left)) || 0;
			const rightPriority = Number(getPriority(right)) || 0;
			if (rightPriority !== leftPriority) return rightPriority - leftPriority;
		}

		return String(right?.source || '').localeCompare(String(left?.source || ''));
	});
}
