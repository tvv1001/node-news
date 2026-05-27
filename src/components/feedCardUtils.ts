function trimTokenTrailingPunctuation(token = '') {
	let normalized = String(token || '');
	while (/[),.;!?]$/.test(normalized)) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

function stripRedditInlineLabels(text = '') {
	return String(text || '')
		.replace(/\s*\[(?:link|comments?)\]/gi, ' ')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function parseHost(value = '') {
	try {
		return new URL(String(value || '')).hostname.toLowerCase();
	} catch {
		return '';
	}
}

function isRedditHost(host = '') {
	return /(^|\.)reddit\.com$/i.test(String(host || '').trim()) || /^redd\.it$/i.test(String(host || '').trim());
}

function isRedditCommentsUrl(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return false;

	try {
		const url = new URL(normalized);
		return isRedditHost(url.hostname) && /\/comments\//i.test(url.pathname);
	} catch {
		return false;
	}
}

function buildCandidateUrl(value = '') {
	const normalized = trimTokenTrailingPunctuation(String(value || '').trim());
	if (!normalized) return '';
	if (/^https?:\/\//i.test(normalized)) return normalized;
	if (/^(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"]*)?$/i.test(normalized)) {
		return `https://${normalized.replace(/^https?:\/\//i, '')}`;
	}
	return '';
}

function collectItemHosts(item: any = {}) {
	return [...new Set([item?.link, item?.homepage, item?.feedUrl].map(parseHost).filter(Boolean))];
}

function buildHandleProfileUrl(token = '', item: any = {}) {
	const rawToken = String(token || '').trim();
	if (!rawToken) return '';

	const hosts = collectItemHosts(item);
	const primaryHost = hosts[0] || '';

	if (/^@[a-z0-9_]{1,30}$/i.test(rawToken)) {
		const handle = rawToken.slice(1);
		if (!handle) return '';

		if (/(^|\.)(twitter\.com)$/i.test(primaryHost)) {
			return `https://twitter.com/${handle}`;
		}
		if (/(^|\.)instagram\.com$/i.test(primaryHost)) {
			return `https://www.instagram.com/${handle}/`;
		}
		if (/(^|\.)github\.com$/i.test(primaryHost)) {
			return `https://github.com/${handle}`;
		}
		if (/(^|\.)tiktok\.com$/i.test(primaryHost)) {
			return `https://www.tiktok.com/@${handle}`;
		}
		if (/(^|\.)threads\.net$/i.test(primaryHost)) {
			return `https://www.threads.net/@${handle}`;
		}
		if (/(^|\.)youtube\.com$/i.test(primaryHost)) {
			return `https://www.youtube.com/@${handle}`;
		}
		return '';
	}

	if (/^\/?u\/[a-z0-9_-]+$/i.test(rawToken) && hosts.some((host) => isRedditHost(host))) {
		const handle = rawToken.replace(/^\//, '').slice(2);
		return handle ? `https://www.reddit.com/user/${handle}/` : '';
	}

	if (/^r\/[a-z0-9_]+$/i.test(rawToken) && hosts.some((host) => isRedditHost(host))) {
		const subreddit = rawToken.slice(2);
		return subreddit ? `https://www.reddit.com/r/${subreddit}/` : '';
	}

	return '';
}

function resolveRedditInlineTokenHref(token = '', item: any = {}) {
	const normalized = String(token || '')
		.trim()
		.toLowerCase();
	if (!normalized) return '';

	const commentsLink = String(item?.commentsLink || '').trim();
	const originalLink = String(item?.originalLink || '').trim();
	const itemLink = String(item?.link || '').trim();
	const guidLink = String(item?.guid || '').trim();

	const inferredCommentsLink = commentsLink || (isRedditCommentsUrl(itemLink) ? itemLink : '') || (isRedditCommentsUrl(guidLink) ? guidLink : '');
	const inferredOriginalLink = originalLink || (itemLink && !isRedditCommentsUrl(itemLink) ? itemLink : '') || (guidLink && !isRedditCommentsUrl(guidLink) ? guidLink : '');

	if (normalized === '[comments]') {
		return inferredCommentsLink || '';
	}

	if (normalized === '[link]') {
		return inferredOriginalLink || inferredCommentsLink || '';
	}

	return '';
}

function buildInlineHref(token = '', item: any = {}, fullText = '', startIndex = 0) {
	const normalizedToken = trimTokenTrailingPunctuation(String(token || '').trim());
	if (!normalizedToken) return '';

	if (/^@[a-z0-9_]{1,30}$/i.test(normalizedToken)) {
		const previousCharacter = startIndex > 0 ? fullText[startIndex - 1] : '';
		if (/[\w.+-]/.test(previousCharacter || '')) {
			return '';
		}
		return buildHandleProfileUrl(normalizedToken, item);
	}

	if (/^\/?u\/[a-z0-9_-]+$/i.test(normalizedToken) || /^r\/[a-z0-9_]+$/i.test(normalizedToken)) {
		return buildHandleProfileUrl(normalizedToken, item);
	}

	return buildCandidateUrl(normalizedToken);
}

export function extractLinkifiedFeedTokens(text = '', item: any = {}) {
	const normalizedText = stripRedditInlineLabels(text);
	if (!normalizedText) return [];

	const tokens: Array<{ type: 'text' | 'link'; value: string; href?: string }> = [];
	const matcher = /https?:\/\/[^\s<>"')\]]+|(?:www\.)?[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[^\s<>"')\]]*)?|@[a-z0-9_]{1,30}\b|\/?u\/[a-z0-9_-]+\b|\br\/[a-z0-9_]+\b/gi;
	let lastIndex = 0;
	let match: RegExpExecArray | null = null;

	while ((match = matcher.exec(normalizedText))) {
		const matchedValue = match[0] || '';
		const startIndex = match.index;
		const href = buildInlineHref(matchedValue, item, normalizedText, startIndex);
		if (!href) continue;

		const displayValue = trimTokenTrailingPunctuation(matchedValue);
		const endIndex = startIndex + displayValue.length;

		if (startIndex > lastIndex) {
			tokens.push({ type: 'text', value: normalizedText.slice(lastIndex, startIndex) });
		}

		tokens.push({ type: 'link', value: displayValue, href });
		lastIndex = endIndex;
	}

	if (lastIndex < normalizedText.length) {
		tokens.push({ type: 'text', value: normalizedText.slice(lastIndex) });
	}

	return tokens.length ? tokens : [{ type: 'text', value: normalizedText }];
}

export function getFeedSourceHref(item: any = {}) {
	return String(item?.homepage || item?.feedUrl || '').trim();
}
