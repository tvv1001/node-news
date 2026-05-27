'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { addContextTags, fetchContextMonitor, replaceContextTags, searchPersonLive } from '../api';
import AiResponsesColumn from './AiResponsesColumn';
import ContextFeedColumn from './ContextFeedColumn';
import { ALL_NEWS_TAG, isAllNewsTag, normalizeContextTagForSync } from './contextFeedTagUtils';
import SearchForm, { DEFAULT_SEARCH_TERM } from './SearchForm';
import ResultsList from './ResultsList';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';
const CONTEXT_BASE = process.env.NEXT_PUBLIC_CONTEXT_API_URL || API_BASE;
const CONTEXT_RETRY_MS = 15000;
const CONTEXT_OFFLINE_MESSAGE = 'Context feed service is offline. Start the feed service to enable live tags and live updates.';
const SEARCH_OFFLINE_MESSAGE = 'Slow crawler is offline. Start the backend on port 3001 or run the full dev stack to enable source crawling.';
const AUTO_START_SLOW_CRAWLER = /^(1|true|yes|on)$/i.test(String(process.env.NEXT_PUBLIC_AUTO_START_SLOW_CRAWLER || 'false'));
const LEFT_CONTEXT_TAG_STORAGE_KEY = 'query-notify.left-context-tag';
const ACTIVE_CONTEXT_TAG_STORAGE_KEY = 'query-notify.active-context-tag';
const RESEARCH_CONTEXT_TAG_STORAGE_KEY = 'query-notify.research-context-tag';
const LEGACY_DUPLICATE_CONTEXT_TAG_STORAGE_KEY = 'query-notify.duplicate-context-tag';

function createContextMonitorState() {
	return {
		started: false,
		streamVersion: 0,
		tags: [] as any[],
		keywords: [] as any[],
		matches: [] as any[],
		generalNews: [] as any[],
		contexts: { research: [] as any[], news: [] as any[], shopping: [] as any[] },
		lastUpdatedAt: '',
		lastError: '',
		generalNewsLastUpdatedAt: '',
		generalNewsLastError: '',
		progressiveFeedState: {
			active: false,
			phase: 'complete',
			generalNewsLoadedCount: 0,
			generalNewsTotal: 0,
			matchesLoadedCount: 0,
			matchesTotal: 0,
		},
	};
}

function useContextMonitor({ enabled = true } = {}) {
	const [monitor, setMonitor] = useState(createContextMonitorState);
	const workerRef = useRef<Worker | null>(null);

	useEffect(() => {
		if (!enabled) {
			setMonitor(createContextMonitorState());
			return undefined;
		}

		if (typeof Worker === 'undefined') {
			setMonitor((current: any) => ({
				...current,
				lastError: CONTEXT_OFFLINE_MESSAGE,
			}));
			return undefined;
		}

		const worker = new Worker(new URL('../workers/contextMonitorWorker.ts', import.meta.url));
		workerRef.current = worker;

		worker.addEventListener('message', (event) => {
			const { type, status, snapshot, error } = event.data || {};

			if (type === 'status') {
				if (status === 'offline') {
					setMonitor((current: any) => ({
						...current,
						lastError: current.lastError || CONTEXT_OFFLINE_MESSAGE,
					}));
				}
				return;
			}

			if (type === 'snapshot') {
				setMonitor((current: any) => ({
					...current,
					...(snapshot || {}),
					lastError: snapshot?.lastError || '',
				}));
				return;
			}

			if (type === 'worker-error') {
				setMonitor((current: any) => ({
					...current,
					lastError: error || current.lastError || CONTEXT_OFFLINE_MESSAGE,
				}));
			}
		});

		worker.postMessage({
			type: 'init',
			payload: {
				contextBase: CONTEXT_BASE,
				retryMs: CONTEXT_RETRY_MS,
			},
		});

		return () => {
			worker.postMessage({ type: 'stop' });
			worker.terminate();
			if (workerRef.current === worker) {
				workerRef.current = null;
			}
		};
	}, [enabled]);

	return monitor;
}

function getPreferredResearchTag(tags: any[] = [], primaryTag = '') {
	if (!Array.isArray(tags) || !tags.length) return '';
	return tags.find((tag) => tag !== primaryTag) || tags[0] || '';
}

function getStoredString(key: string, fallback = '') {
	if (typeof window === 'undefined') return fallback;
	return window.localStorage.getItem(key) || fallback;
}

function normalizeTagList(tags: any[] = []) {
	return [...new Set((Array.isArray(tags) ? tags : []).map((tag) => normalizeContextTagForSync(tag)).filter(Boolean))].sort((left: any, right: any) => left.localeCompare(right));
}

function haveContextTagsChanged(left: any[] = [], right: any[] = []) {
	const normalizedLeft = normalizeTagList(left);
	const normalizedRight = normalizeTagList(right);
	if (normalizedLeft.length !== normalizedRight.length) return true;

	return normalizedLeft.some((tag, index) => tag !== normalizedRight[index]);
}

function normalizeCrawlerSeedTag(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized || isAllNewsTag(normalized)) return '';
	return normalized;
}

function formatCrawlerTagLabel(value = '') {
	const normalized = normalizeCrawlerSeedTag(value);
	if (!normalized) return 'current tag';
	return normalized.startsWith('$') ? normalized : `#${normalized}`;
}

function formatCrawlerQueryLabel(value = '') {
	const normalized = String(value || '').trim();
	return normalized || DEFAULT_SEARCH_TERM;
}

function buildCrawlerDescription(query = '') {
	const label = formatCrawlerQueryLabel(query);
	return `Slow crawl mode scans source pages and supporting documents for ${label}. It is intentionally slower than the live feed, but much nosier—in a good way.`;
}

function hasLiveLaneSnapshotReady(monitor: any = {}) {
	if (!monitor || typeof monitor !== 'object') return false;
	if (monitor.lastError) return true;
	if (monitor.lastUpdatedAt || monitor.generalNewsLastUpdatedAt) return true;
	if (Array.isArray(monitor.matches) && monitor.matches.length > 0) return true;
	if (Array.isArray(monitor.contexts?.news) && monitor.contexts.news.length > 0) return true;
	if (Array.isArray(monitor.contexts?.research) && monitor.contexts.research.length > 0) return true;
	return false;
}

function formatSearchErrorMessage(error: any) {
	const message = String(error?.message || '').trim();
	if (!message) {
		return 'Search failed. Please try again.';
	}

	if (error instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(message)) {
		return SEARCH_OFFLINE_MESSAGE;
	}

	return message;
}

function App() {
	const [results, setResults] = useState([] as any[]);
	const [aiResponses, setAiResponses] = useState([] as any[]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState('');
	const [searchTerm, setSearchTerm] = useState('');
	const [manualCrawlerSearchValue, setManualCrawlerSearchValue] = useState(DEFAULT_SEARCH_TERM);
	const [searchProgress, setSearchProgress] = useState(null as any);
	const [hasLoadedPersistedContextState, setHasLoadedPersistedContextState] = useState(false);
	const [leftContextTag, setLeftContextTag] = useState(ALL_NEWS_TAG);
	const [activeContextTag, setActiveContextTag] = useState('');
	const [researchContextTag, setResearchContextTag] = useState('');
	const [hasInitializedContextSelections, setHasInitializedContextSelections] = useState(false);
	const contextSyncSignatureRef = useRef('');
	const contextSyncInFlightRef = useRef('');
	const scannedResultCount = useMemo(() => results.filter((result: any) => result?.resultType !== 'ai-answer' && result?.url).length, [results]);
	const contextSyncRetryAtRef = useRef(0);
	const contextSyncTimerRef = useRef<number | null>(null);
	const activeSearchRequestIdRef = useRef(0);
	const hasStartedInitialCrawlerRef = useRef(false);
	const sharedContextMonitor = useContextMonitor({ enabled: true });
	const contextKeywords =
		(sharedContextMonitor?.tags?.length ? sharedContextMonitor.tags : null) || (sharedContextMonitor?.keywords?.length ? sharedContextMonitor.keywords : null) || [];

	useEffect(() => {
		setLeftContextTag(getStoredString(LEFT_CONTEXT_TAG_STORAGE_KEY, ALL_NEWS_TAG));
		setActiveContextTag(getStoredString(ACTIVE_CONTEXT_TAG_STORAGE_KEY));
		setResearchContextTag(getStoredString(RESEARCH_CONTEXT_TAG_STORAGE_KEY, getStoredString(LEGACY_DUPLICATE_CONTEXT_TAG_STORAGE_KEY)));
		setHasLoadedPersistedContextState(true);
	}, []);

	useEffect(() => {
		if (!hasLoadedPersistedContextState || hasInitializedContextSelections) {
			return;
		}

		const monitorTags = Array.isArray(contextKeywords) ? contextKeywords : [];
		if (!leftContextTag) {
			setLeftContextTag(ALL_NEWS_TAG);
		}

		const hasCustomLeftTag = Boolean(leftContextTag) && !isAllNewsTag(leftContextTag);

		if (activeContextTag || hasCustomLeftTag) {
			if (activeContextTag && !researchContextTag && monitorTags.length) {
				setResearchContextTag(getPreferredResearchTag(monitorTags, activeContextTag));
				return;
			}

			setHasInitializedContextSelections(true);
			return;
		}

		// If we have no persisted tags and no monitor tags yet, but the monitor is started,
		// we can consider ourselves initialized with defaults.
		if (sharedContextMonitor?.started) {
			setHasInitializedContextSelections(true);
		}
	}, [leftContextTag, activeContextTag, contextKeywords, researchContextTag, hasInitializedContextSelections, hasLoadedPersistedContextState, sharedContextMonitor?.started]);

	useEffect(() => {
		if (!hasLoadedPersistedContextState || !hasInitializedContextSelections) return;
		if (!sharedContextMonitor?.started) return;

		const desiredTags = normalizeTagList([leftContextTag, activeContextTag, researchContextTag]);
		const observedTags = normalizeTagList(contextKeywords);
		const syncSignature = JSON.stringify({ desiredTags, observedTags });
		const now = Date.now();
		const debounceMs = 350;

		if (contextSyncTimerRef.current) {
			window.clearTimeout(contextSyncTimerRef.current);
			contextSyncTimerRef.current = null;
		}

		if (contextSyncRetryAtRef.current > now) {
			return;
		}

		if (contextSyncInFlightRef.current === syncSignature) {
			return;
		}

		if (!haveContextTagsChanged(desiredTags, observedTags) && contextSyncSignatureRef.current === syncSignature) {
			return;
		}
		let cancelled = false;

		const syncContextTags = async () => {
			contextSyncInFlightRef.current = syncSignature;
			try {
				await replaceContextTags(desiredTags);
				if (cancelled) return;
				contextSyncSignatureRef.current = JSON.stringify({ desiredTags, observedTags: desiredTags });
				contextSyncRetryAtRef.current = 0;
			} catch (syncError) {
				if (cancelled) return;
				if (syncError?.status === 429) {
					contextSyncRetryAtRef.current = Date.now() + 5000;
					return;
				}
				console.error('Unable to sync context tags.', syncError);
			} finally {
				if (contextSyncInFlightRef.current === syncSignature) {
					contextSyncInFlightRef.current = '';
				}
			}
		};

		contextSyncTimerRef.current = window.setTimeout(() => {
			void syncContextTags();
		}, debounceMs);

		return () => {
			cancelled = true;
			if (contextSyncTimerRef.current) {
				window.clearTimeout(contextSyncTimerRef.current);
				contextSyncTimerRef.current = null;
			}
		};
	}, [leftContextTag, activeContextTag, researchContextTag, hasInitializedContextSelections, hasLoadedPersistedContextState, contextKeywords, sharedContextMonitor?.started]);

	useEffect(() => {
		if (!hasLoadedPersistedContextState || typeof window === 'undefined') return;
		if (!leftContextTag) {
			window.localStorage.removeItem(LEFT_CONTEXT_TAG_STORAGE_KEY);
			return;
		}

		window.localStorage.setItem(LEFT_CONTEXT_TAG_STORAGE_KEY, leftContextTag);
	}, [leftContextTag, hasLoadedPersistedContextState]);

	useEffect(() => {
		if (!hasLoadedPersistedContextState || typeof window === 'undefined') return;
		if (!activeContextTag) {
			window.localStorage.removeItem(ACTIVE_CONTEXT_TAG_STORAGE_KEY);
			return;
		}

		window.localStorage.setItem(ACTIVE_CONTEXT_TAG_STORAGE_KEY, activeContextTag);
	}, [activeContextTag, hasLoadedPersistedContextState]);

	useEffect(() => {
		if (!hasLoadedPersistedContextState || typeof window === 'undefined') return;
		if (!researchContextTag) {
			window.localStorage.removeItem(RESEARCH_CONTEXT_TAG_STORAGE_KEY);
			return;
		}

		window.localStorage.setItem(RESEARCH_CONTEXT_TAG_STORAGE_KEY, researchContextTag);
		window.localStorage.removeItem(LEGACY_DUPLICATE_CONTEXT_TAG_STORAGE_KEY);
	}, [researchContextTag, hasLoadedPersistedContextState]);

	const handleSearch = async (searchValue: string, options: any = {}) => {
		const normalizedSearchValue = String(searchValue || '').trim();
		if (!normalizedSearchValue) return;
		const isTagOrigin = options.origin === 'tag';

		const requestId = activeSearchRequestIdRef.current + 1;
		activeSearchRequestIdRef.current = requestId;
		setLoading(true);
		setError('');
		setManualCrawlerSearchValue(normalizedSearchValue);
		setSearchTerm(normalizedSearchValue);
		setSearchProgress({
			status: 'queued',
			progress: 0,
			currentActivity: isTagOrigin ? `Queueing slow crawl for ${formatCrawlerTagLabel(normalizedSearchValue)}…` : 'Queueing crawl…',
			crawlStatuses: [],
		});
		try {
			const data = await searchPersonLive({ searchTerm: normalizedSearchValue, queryProfile: 'research-documents' }, (snapshot: any) => {
				if (activeSearchRequestIdRef.current !== requestId) return;
				setSearchProgress(snapshot);
			});
			if (activeSearchRequestIdRef.current !== requestId) return;
			setResults(data.searchResults || data.results || []);
			setAiResponses(Array.isArray(data.aiResponses) ? data.aiResponses : []);
			setSearchProgress((current: any) => ({
				...(current || {}),
				status: 'completed',
				progress: 100,
				currentActivity: `Crawler finished for ${formatCrawlerTagLabel(normalizedSearchValue)}`,
				crawlStatuses: data.crawlStatuses || current?.crawlStatuses || [],
			}));
		} catch (error: any) {
			if (activeSearchRequestIdRef.current !== requestId) return;
			const errorMessage = formatSearchErrorMessage(error);
			if (errorMessage !== SEARCH_OFFLINE_MESSAGE) {
				console.error('Search failed:', error);
			}
			setError(errorMessage);
			setResults([]);
			setSearchProgress((current: any) => ({
				...(current || {}),
				status: 'failed',
				currentActivity: errorMessage,
			}));
		} finally {
			if (activeSearchRequestIdRef.current === requestId) {
				setLoading(false);
			}
		}
	};

	const handleAddTag = async (tag: string) => {
		await addContextTags([tag]);
		await fetchContextMonitor({ refresh: true }).catch(() => {});
	};

	const handleClearPrimaryContextTag = () => {
		setActiveContextTag('');
	};

	const handleClearLeftContextTag = () => {
		setLeftContextTag('');
	};

	const handleClearResearchContextTag = () => {
		setResearchContextTag('');
	};

	const crawlerSeedTag = normalizeCrawlerSeedTag(activeContextTag);
	const crawlerSeedLabel = formatCrawlerTagLabel(crawlerSeedTag);
	const activeCrawlerQuery = String(searchTerm || manualCrawlerSearchValue || DEFAULT_SEARCH_TERM).trim() || DEFAULT_SEARCH_TERM;
	const isCrawlerRunning = loading || searchProgress?.status === 'queued' || searchProgress?.status === 'running';
	const crawlStatuses = Array.isArray(searchProgress?.crawlStatuses) ? searchProgress.crawlStatuses : [];
	const crawlProgressPercent = Number.isFinite(searchProgress?.progress) ? Math.max(0, Math.min(100, Number(searchProgress.progress))) : 0;
	const hasInitializedLiveLanes = hasLiveLaneSnapshotReady(sharedContextMonitor);

	useEffect(() => {
		if (!AUTO_START_SLOW_CRAWLER) {
			return;
		}
		if (hasStartedInitialCrawlerRef.current) {
			return;
		}
		if (!hasInitializedLiveLanes) {
			return;
		}

		hasStartedInitialCrawlerRef.current = true;
		void handleSearch(DEFAULT_SEARCH_TERM, { origin: 'default' });
	}, [hasInitializedLiveLanes]);

	return (
		<div className='app-shell'>
			<nav className='app-nav'>
				<span className='app-nav-brand'>News & Research</span>
				<div style={{ marginLeft: 'auto', display: 'flex', gap: '12px' }}>
					<a
						href='/pipeline'
						className='app-nav-link'
						target='_blank'
						rel='noopener noreferrer'>
						Pipeline
					</a>
					<a
						href='/sse-dashboard'
						className='app-nav-link'
						target='_blank'
						rel='noopener noreferrer'>
						SSE Dashboard
					</a>
				</div>
			</nav>

			{(sharedContextMonitor.lastError || sharedContextMonitor.lastUpdatedAt) && (
				<div className={`context-banner ${sharedContextMonitor.lastError ? 'context-banner-error' : 'context-banner-info'}`}>
					<span className='context-banner-message'>
						{sharedContextMonitor.lastError ?
							`Feed warning: ${sharedContextMonitor.lastError}`
						:	`Feeds active • Last updated ${new Date(sharedContextMonitor.lastUpdatedAt).toLocaleTimeString()}`}
					</span>
				</div>
			)}

			<section className='search-layout has-research-context-column'>
				<ContextFeedColumn
					columnKey='left'
					monitor={sharedContextMonitor}
					activeTag={leftContextTag}
					contextFilter='news'
					columnTitle='News Lane'
					showComposer={true}
					allowActiveTagClear={true}
					onClearActiveTag={handleClearLeftContextTag}
					onSelectTag={setLeftContextTag}
					onAddTag={handleAddTag}
				/>

				<ContextFeedColumn
					columnKey='primary'
					monitor={sharedContextMonitor}
					activeTag={activeContextTag}
					contextFilter='all'
					columnTitle='Tag Lane'
					showComposer={true}
					allowActiveTagClear={true}
					onClearActiveTag={handleClearPrimaryContextTag}
					onSelectTag={setActiveContextTag}
					onAddTag={handleAddTag}
				/>

				<ContextFeedColumn
					columnKey='research'
					monitor={sharedContextMonitor}
					activeTag={researchContextTag}
					contextFilter='research'
					columnTitle='Research Lane'
					showComposer={true}
					allowActiveTagClear={true}
					onClearActiveTag={handleClearResearchContextTag}
					onSelectTag={setResearchContextTag}
					onAddTag={handleAddTag}
				/>

				<div className='search-main-column has-research-context-column'>
					<div className='panel form-panel'>
						<div className='live-status-panel'>
							<div className='live-status-summary'>
								<div>
									<div className='live-panel-title'>Slow Crawler</div>
									<div className='live-status-text'>
										{isCrawlerRunning ? `Crawling documents and source pages for ${activeCrawlerQuery}.` : `Showing documents and source pages for ${activeCrawlerQuery}.`}
									</div>
								</div>
								<span className='live-status-percent'>{crawlProgressPercent}%</span>
							</div>
							<div className='live-progress-track'>
								<span
									className='live-progress-fill'
									style={{ width: `${crawlProgressPercent}%` }}></span>
							</div>
							<div className='status-meta'>
								<div className='status-meta-activity'>{searchProgress?.currentActivity || `Ready to crawl ${activeCrawlerQuery}`}</div>
							</div>
							{crawlStatuses.length > 0 && (
								<div className='crawl-status-list'>
									{crawlStatuses.map((entry: any, index: number) => (
										<div
											key={`${entry.source || 'crawler'}-${index}`}
											className='crawl-status-row'>
											<div>
												<div className='crawl-source'>{entry.source || 'crawler'}</div>
												<div className='crawl-kind'>{entry.message || entry.kind || 'Scanning source pages'}</div>
											</div>
											<span className={`crawl-state ${entry.status || 'queued'}`}>{entry.status || 'queued'}</span>
											<span className='crawl-kind'>{entry.itemCount || 0} items</span>
										</div>
									))}
								</div>
							)}
						</div>
						<SearchForm
							onSearch={handleSearch}
							loading={loading}
							defaultSearchValue={manualCrawlerSearchValue}
							title='Slow crawler'
							description={buildCrawlerDescription(activeCrawlerQuery)}
							label='Crawler query'
							placeholder='Enter a tag or operator-rich query, e.g. site:gov "land records" after:2025-01-01'
							submitLabel='Crawl sources'
							resetLabel='Reset query'
						/>
					</div>

					<div className='search-results-layout'>
						<div className='panel results-panel'>
							<ResultsList
								results={results}
								loading={loading}
								error={error}
								searchTerm={searchTerm}
								loadingTitle={`Crawling ${activeCrawlerQuery}…`}
								loadingDescription={`Scanning sites and supporting documents related to ${activeCrawlerQuery}.`}
								emptyTitle={`No document hits yet for ${activeCrawlerQuery}`}
								emptyDescription={`The slow crawler finished, but it did not find any grouped documents or scanned pages for ${activeCrawlerQuery} yet.`}
								resultsSectionKicker=''
								resultsSectionTitle={`Search Results (${scannedResultCount})`}
								resultsSectionDescription=''
								showResultsCount={false}
								aiResponses={aiResponses}
							/>
						</div>
						<div className='panel ai-results-panel'>
							<AiResponsesColumn
								results={results}
								aiResponses={aiResponses}
								emptyDescription=''
								loading={loading}
								error={error}
								searchTerm={searchTerm}
								title={`AI responses for ${activeCrawlerQuery}`}
								description={`Model summaries and cited links for ${activeCrawlerQuery} stay in this side lane, keeping the source cards easier to scan.`}
								emptyTitle={`No AI summaries yet for ${activeCrawlerQuery}`}
							/>
						</div>
					</div>
				</div>
			</section>
		</div>
	);
}

export default App;
