import { useEffect, useMemo, useRef, useState } from 'react';
import { ALL_NEWS_TAG, isAllNewsTag } from './contextFeedTagUtils';
import { isFutureDatedFeedItem, sortFeedItemsNewestFirst } from './contextFeedChronology';
import { getLiveFeedRecencyPriority, isSuppressedLiveFeedItem } from './liveFeedSourcePolicy';
import FeedCard from './FeedCard';

const ALL_NEWS_LANE_LIMIT = 40;
const TAGGED_LANE_LIMIT = 10;

function normalizeTagKeyword(value = '') {
	return String(value || '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function buildTagSearchableText(item: any = {}) {
	return [item?.title, item?.summary, item?.source, item?.feedUrl, item?.homepage, item?.link, ...(Array.isArray(item?.tags) ? item.tags : [])]
		.filter(Boolean)
		.join(' ')
		.toLowerCase();
}

function getContextItems(monitor: any = {}, contextFilter = 'news') {
	if (contextFilter === 'all') {
		return Object.values(monitor?.contexts || {}).flatMap((items: any) => (Array.isArray(items) ? items : []));
	}

	return Array.isArray(monitor?.contexts?.[contextFilter]) ? monitor.contexts[contextFilter] : [];
}

function matchesTagExpression(searchableText = '', normalizedTag = '') {
	const normalizedExpression = normalizeTagKeyword(normalizedTag);
	if (!normalizedExpression) return false;

	const orParts = normalizedExpression
		.split(/\s+(?:or|\|)\s+/i)
		.map((part) => part.trim())
		.filter(Boolean);
	if (orParts.length > 1) {
		return orParts.some((part) => matchesTagExpression(searchableText, part));
	}

	const andParts = normalizedExpression
		.split(/\s+and\s+/i)
		.map((part) => part.trim())
		.filter(Boolean);
	if (andParts.length > 1) {
		return andParts.every((part) => matchesTagExpression(searchableText, part));
	}

	const phrase = normalizedExpression.replace(/^"|"$/g, '').trim();
	if (!phrase) return false;

	return searchableText.includes(phrase);
}

function dedupeFeedItems(items: any[] = []) {
	const dedupedItems: any[] = [];
	const seenKeys = new Set();

	for (const item of Array.isArray(items) ? items : []) {
		const itemKey = buildFeedItemIdentityKey(item);
		if (!itemKey || seenKeys.has(itemKey)) continue;

		seenKeys.add(itemKey);
		dedupedItems.push(item);
	}

	return dedupedItems;
}

function normalizeComparableText(value = '') {
	return String(value || '')
		.trim()
		.toLowerCase()
		.replace(/\s+/g, ' ');
}

function normalizeFeedUrlKey(value = '') {
	const normalizedValue = String(value || '').trim();
	if (!normalizedValue) return '';

	try {
		const url = new URL(normalizedValue);
		const normalizedHost = url.hostname.toLowerCase().replace(/^(?:www|old|np|new)\./, '');
		const normalizedPath = url.pathname.replace(/\/+$/, '');

		if (normalizedHost === 'redd.it') {
			const pathParts = normalizedPath.split('/').filter(Boolean);
			return pathParts[0] ? `reddit:short:${pathParts[0].toLowerCase()}` : `https://${normalizedHost}${normalizedPath}`;
		}

		const redditThreadMatch = normalizedPath.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
		if (normalizedHost.endsWith('reddit.com') && redditThreadMatch?.[1]) {
			return `reddit:thread:${redditThreadMatch[1].toLowerCase()}`;
		}

		url.hash = '';
		url.search = '';
		return `${url.protocol}//${normalizedHost}${normalizedPath}`.toLowerCase();
	} catch {
		return normalizeComparableText(normalizedValue);
	}
}

function buildFeedItemIdentityKey(item: any = {}) {
	const rawId = normalizeComparableText(item?.id || '');
	if (rawId.startsWith('t3_')) {
		const commentVariantSuffix = rawId.includes('#comment') ? ':comment' : ':primary';
		return `reddit:thread:${rawId}${commentVariantSuffix}`;
	}

	const redditKey = normalizeFeedUrlKey(item?.commentsLink || item?.link || item?.guid || '');
	if (redditKey.startsWith('reddit:thread:') || redditKey.startsWith('reddit:short:')) {
		const commentVariantSuffix = normalizeComparableText(item?.id || '').includes('#comment') ? ':comment' : ':primary';
		return `${redditKey}${commentVariantSuffix}`;
	}

	const normalizedLink = normalizeFeedUrlKey(item?.link || item?.originalLink || item?.commentsLink || '');
	if (normalizedLink) return normalizedLink;

	const source = normalizeComparableText(item?.source || item?.homepage || item?.feedUrl || 'feed');
	const title = normalizeComparableText(item?.title || item?.summary || 'untitled');
	return `${source}:${title}`;
}

function buildFeedItemHydrationKey(item: any = {}) {
	return buildFeedItemIdentityKey(item);
}

function buildFeedItemHydrationSignature(item: any = {}) {
	return JSON.stringify({
		id: item?.id || '',
		link: item?.link || '',
		title: item?.title || '',
		summary: item?.summary || '',
		source: item?.source || '',
		author: item?.author || '',
		context: item?.context || '',
		publishedAt: item?.publishedAt || '',
		discoveredAt: item?.discoveredAt || '',
		previewImageSrc: item?.previewImage?.src || '',
		previewImageAlt: item?.previewImage?.alt || '',
		originalLink: item?.originalLink || '',
		commentsLink: item?.commentsLink || '',
		tags: Array.isArray(item?.tags) ? item.tags : [],
		matchedKeywords: Array.isArray(item?.matchedKeywords) ? item.matchedKeywords : [],
	});
}

function mergeHydratedFeedItems(previousItems: any[] = [], nextItems: any[] = []) {
	const previousEntries = new Map<string, { item: any; signature: string }>();
	for (const item of Array.isArray(previousItems) ? previousItems : []) {
		const key = buildFeedItemHydrationKey(item);
		if (!key) continue;
		previousEntries.set(key, { item, signature: buildFeedItemHydrationSignature(item) });
	}

	return (Array.isArray(nextItems) ? nextItems : []).map((item) => {
		const key = buildFeedItemHydrationKey(item);
		if (!key) return item;

		const previousEntry = previousEntries.get(key);
		if (!previousEntry) return item;

		return previousEntry.signature === buildFeedItemHydrationSignature(item) ? previousEntry.item : item;
	});
}

function getLiveFeedLaneLimit(activeTag = '', contextFilter = 'news') {
	if (isAllNewsTag(activeTag) && contextFilter === 'news') {
		return ALL_NEWS_LANE_LIMIT;
	}

	return TAGGED_LANE_LIMIT;
}

function formatArticleTimestamp(publishedAt = '', discoveredAt = '') {
	const value = publishedAt || discoveredAt;
	if (!value) return 'Timestamp unavailable';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'Timestamp unavailable';

	return date.toLocaleString([], {
		month: 'short',
		day: 'numeric',
		hour: 'numeric',
		minute: '2-digit',
	});
}

function formatTagLabel(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return '';
	if (isAllNewsTag(normalized)) return 'All news';
	if (
		/[|()"*-]/.test(normalized) ||
		/\s+(and|or)\s+/i.test(normalized) ||
		/\b(?:site|source|filetype|ext|intitle|allintitle|inurl|allinurl|intext|allintext|before|after):/i.test(normalized)
	) {
		return normalized
			.replace(/\s+and\s+/gi, ' AND ')
			.replace(/\s+or\s+/gi, ' OR ')
			.replace(/\s*\|\s*/g, ' OR ');
	}
	return normalized.startsWith('$') ? normalized : `#${normalized}`;
}

function ContextFeedColumn({
	columnKey = 'primary',
	monitor = {} as any,
	activeTag = '',
	contextFilter = 'news',
	columnTitle = '',
	showComposer = true,
	allowActiveTagClear = false,
	onClearActiveTag,
	onSelectTag,
	onAddTag,
	draftTagValue,
	onDraftTagChange,
	itemFilter,
}: any) {
	const [draftTag, setDraftTag] = useState('');
	const [tagActionError, setTagActionError] = useState('');
	const [isSavingTag, setIsSavingTag] = useState(false);
	const [hydratedFeedItems, setHydratedFeedItems] = useState([] as any[]);
	const hydratedLaneKeyRef = useRef('');
	const isDraftControlled = typeof draftTagValue === 'string';
	const currentDraftTag = isDraftControlled ? draftTagValue : draftTag;
	const tagInputId = `context-tag-input-${columnKey}`;
	const progressiveFeedState = monitor.progressiveFeedState || {};
	const isTaggedStreamColumn = Boolean(activeTag) && !isAllNewsTag(activeTag);
	const laneHydrationKey = `${columnKey}:${contextFilter}:${normalizeTagKeyword(activeTag)}`;
	const laneItemLimit = getLiveFeedLaneLimit(activeTag, contextFilter);

	const incomingFilteredNewsItems = useMemo(() => {
		const normalizedActiveTag = normalizeTagKeyword(activeTag);
		if (!normalizedActiveTag) {
			if (contextFilter === 'research') {
				const researchSourceItems = Array.isArray(monitor.matches) ? monitor.matches : [];
				const researchContextItems = getContextItems(monitor, contextFilter);
				const researchItems = dedupeFeedItems([...researchSourceItems, ...researchContextItems]).filter((item: any) => {
					const matchesContext = !item?.context || item.context === contextFilter || contextFilter === 'all';
					const passesCustomFilter = !itemFilter || itemFilter(item);

					return matchesContext && passesCustomFilter && !isSuppressedLiveFeedItem(item) && !isFutureDatedFeedItem(item);
				});

				if (researchItems.length) {
					return sortFeedItemsNewestFirst(researchItems, { preferCurrentUpdates: true, getPriority: getLiveFeedRecencyPriority }).slice(0, laneItemLimit);
				}

				return sortFeedItemsNewestFirst(
					Array.isArray(monitor.generalNews) ? monitor.generalNews.filter((item: any) => !isSuppressedLiveFeedItem(item) && !isFutureDatedFeedItem(item)) : [],
				).slice(0, laneItemLimit);
			}

			return [];
		}
		if (isAllNewsTag(normalizedActiveTag)) {
			return sortFeedItemsNewestFirst(
				Array.isArray(monitor.generalNews) ? monitor.generalNews.filter((item: any) => !isSuppressedLiveFeedItem(item) && !isFutureDatedFeedItem(item)) : [],
			).slice(0, laneItemLimit);
		}

		const sourceItems = Array.isArray(monitor.matches) ? monitor.matches : [];
		const contextItems = getContextItems(monitor, contextFilter);
		const taggedGeneralNewsItems =
			contextFilter === 'news' || contextFilter === 'all' ?
				Array.isArray(monitor.generalNews) ?
					monitor.generalNews
				:	[]
			:	[];

		const newsItems = dedupeFeedItems([...taggedGeneralNewsItems, ...sourceItems, ...contextItems]).filter((item: any) => {
			const matchesContext = !item?.context || item.context === contextFilter || contextFilter === 'all';
			const passesCustomFilter = !itemFilter || itemFilter(item);

			return matchesContext && passesCustomFilter && !isSuppressedLiveFeedItem(item) && !isFutureDatedFeedItem(item);
		});

		const matchingItems = newsItems.filter((item: any) => {
			const matchedKeywords = Array.isArray(item?.matchedKeywords) ? item.matchedKeywords.map((keyword: any) => normalizeTagKeyword(keyword)) : [];
			if (matchedKeywords.includes(normalizedActiveTag)) {
				return true;
			}

			const searchableText = buildTagSearchableText(item);

			return matchesTagExpression(searchableText, normalizedActiveTag);
		});
		return sortFeedItemsNewestFirst(matchingItems, { preferCurrentUpdates: true, getPriority: getLiveFeedRecencyPriority }).slice(0, laneItemLimit);
	}, [activeTag, contextFilter, laneItemLimit, monitor.contexts, monitor.generalNews, monitor.matches]);
	const isLoadingMoreMatches = Boolean(progressiveFeedState.active) && (progressiveFeedState.matchesLoadedCount || 0) < (progressiveFeedState.matchesTotal || 0);
	const isWaitingForMatchingItems = Boolean(activeTag) && !isAllNewsTag(activeTag) && isLoadingMoreMatches && incomingFilteredNewsItems.length === 0;

	useEffect(() => {
		if (hydratedLaneKeyRef.current !== laneHydrationKey) {
			hydratedLaneKeyRef.current = laneHydrationKey;
			setHydratedFeedItems(incomingFilteredNewsItems);
			return;
		}

		setHydratedFeedItems((currentItems) => {
			const shouldHoldCurrentItems = currentItems.length > 0 && incomingFilteredNewsItems.length === 0 && (Boolean(progressiveFeedState.active) || isWaitingForMatchingItems);
			if (shouldHoldCurrentItems) {
				return currentItems;
			}

			return mergeHydratedFeedItems(currentItems, incomingFilteredNewsItems);
		});
	}, [incomingFilteredNewsItems, isWaitingForMatchingItems, laneHydrationKey, progressiveFeedState.active]);

	const filteredNewsItems = hydratedFeedItems;

	const handleSubmitTag = async (event: any) => {
		event.preventDefault();
		const nextTag = String(currentDraftTag || '')
			.trim()
			.toLowerCase();
		if (!nextTag) return;

		setIsSavingTag(true);
		setTagActionError('');
		try {
			await onAddTag?.(nextTag);
			if (isDraftControlled) {
				onDraftTagChange?.('');
			} else {
				setDraftTag('');
			}
			onSelectTag?.(nextTag);
		} catch (error: any) {
			setTagActionError(error?.message || 'Unable to save tag right now.');
		} finally {
			setIsSavingTag(false);
		}
	};

	const handleClearLocalTag = () => {
		onClearActiveTag?.();
	};

	const formattedTag = activeTag ? formatTagLabel(activeTag) : 'Tagged stories';
	const effectiveColumnTitle = columnTitle || (isAllNewsTag(activeTag) ? 'All news' : `${formattedTag} ${contextFilter}`);

	return (
		<aside className={`context-feed-column panel ${isTaggedStreamColumn ? 'context-feed-column-tagged' : 'context-feed-column-general'}`}>
			<div className='context-column-header context-column-header-compact'>
				{showComposer && (
					<form
						className='context-tag-form'
						onSubmit={handleSubmitTag}>
						<div className='context-tag-input-row'>
							<label
								htmlFor={tagInputId}
								className='sr-only'>
								Add feed tag for {columnTitle}
							</label>
							<input
								id={tagInputId}
								type='text'
								value={currentDraftTag}
								onChange={(event) => {
									if (isDraftControlled) {
										onDraftTagChange?.(event.target.value);
									} else {
										setDraftTag(event.target.value);
									}
								}}
								placeholder='Add a tag like $tsla, "quantum computing", ai OR robotics'
							/>
							<button
								className='btn btn-primary'
								type='submit'
								disabled={isSavingTag}>
								{activeTag ? 'Change' : 'Add'}
							</button>
						</div>
						{tagActionError && <span className='context-empty-copy'>{tagActionError}</span>}
					</form>
				)}

				<div className='context-keyword-list'>
					{activeTag ?
						<div className='context-keyword-pill is-active'>
							<span className='context-keyword-select'>{formatTagLabel(activeTag)}</span>
							{allowActiveTagClear && (
								<button
									type='button'
									className='context-keyword-remove'
									onClick={handleClearLocalTag}
									aria-label={`Clear tag ${activeTag}`}>
									×
								</button>
							)}
						</div>
					:	<span className='context-empty-copy'>Add one tag to make this column independent.</span>}
				</div>
			</div>
			<div className='context-ticker-card context-column-card context-column-card-fill'>
				<div className='context-ticker-header'>
					<h3>{effectiveColumnTitle}</h3>
					<div className='context-ticker-header-actions'></div>
				</div>
				{isAllNewsTag(activeTag) && monitor.generalNewsLastError && <div className='context-lane-error-msg'>{monitor.generalNewsLastError}</div>}
				<div className='context-ticker-window context-feed-window'>
					<div className='context-ticker-track'>
						{filteredNewsItems.map((item: any) => (
							<FeedCard
								key={item.id || item.link || item.title}
								item={item}
								className={`context-feed-stream-item ${isTaggedStreamColumn ? 'context-feed-stream-item-tagged' : ''}`}
								timestamp={formatArticleTimestamp(item.publishedAt, item.discoveredAt)}
								summaryClassName='context-feed-summary context-feed-summary-scroll'
								timestampClassName='context-notification-item-meta context-feed-timestamp'
								allowDetailedContent={isTaggedStreamColumn}
							/>
						))}
						{!filteredNewsItems.length && !isWaitingForMatchingItems && (
							<div className='context-empty-state-container'>
								<span className='context-empty-copy'>
									{activeTag ?
										isAllNewsTag(activeTag) ?
											'No all-news stories are available yet. Fresh headlines will appear here as the feed refreshes.'
										:	'No RSS or X items are available yet for this feed. Fresh matches will appear here first.'
									:	'Select or add a tag to start this feed view.'}
								</span>
							</div>
						)}
						{!filteredNewsItems.length && isWaitingForMatchingItems && (
							<div className='skeleton-wrapper'>
								<div className='skeleton-item'>
									<div className='skeleton-text-line'></div>
									<div className='skeleton-text-line short'></div>
								</div>
								<div className='skeleton-item'>
									<div className='skeleton-text-line'></div>
									<div className='skeleton-text-line'></div>
									<div className='skeleton-text-line short'></div>
								</div>
								<div className='skeleton-item'>
									<div className='skeleton-text-line'></div>
									<div className='skeleton-text-line short'></div>
								</div>
							</div>
						)}
						{isLoadingMoreMatches && filteredNewsItems.length > 0 && <span className='context-feed-loading-copy'>Refreshing the latest matching stories…</span>}
					</div>
				</div>
			</div>
		</aside>
	);
}

export default ContextFeedColumn;
