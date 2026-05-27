'use client';

import { useEffect, useState } from 'react';
import {
	addContextSource,
	addContextTags,
	fetchContextPortal,
	removeContextSource,
	updateContextSource,
	testContextSource,
	blockContextSource,
	unblockContextSource,
	fetchContextMonitor,
} from '../../api';
import ContextFeedColumn from '../../components/ContextFeedColumn';
import FeedCard from '../../components/FeedCard';
import '../../style.css';

function PipelineStep({ number, title, description, active = false }: any) {
	return (
		<div className={`pipeline-step ${active ? 'is-active' : ''}`}>
			<div className='pipeline-step-number'>{number}</div>
			<div className='pipeline-step-content'>
				<h4>{title}</h4>
				<p>{description}</p>
			</div>
		</div>
	);
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

function buildTaggedTemplateUrl(templateUrl = '', tag = '') {
	const normalizedTemplateUrl = String(templateUrl || '').trim();
	const normalizedTag = String(tag || '').trim();
	if (!normalizedTemplateUrl || !normalizedTag) return '';

	const encodedTag = encodeURIComponent(normalizedTag);
	if (/\{tag\}/i.test(normalizedTemplateUrl)) {
		return normalizedTemplateUrl.replace(/\{tag\}/gi, encodedTag);
	}

	return `${normalizedTemplateUrl}${encodedTag}`;
}

function normalizePortalTagValue(value = '') {
	return String(value || '')
		.toLowerCase()
		.trim()
		.replace(/\s+/g, ' ');
}

function getPipelineFeedText(target: any = {}) {
	return [target?.source, target?.url, target?.urlTemplate, target?.parentUrl, target?.homepage].filter(Boolean).join(' ').toLowerCase();
}

function isXLiveTagTemplate(feed: any = {}) {
	return /(x\.com|twitter\.com|\/twitter\/)/i.test(getPipelineFeedText(feed));
}

function isXLaneFeed(feed: any = {}) {
	return isXLiveTagTemplate(feed);
}

function isXSourceItem(item: any = {}) {
	return /(x\.com|twitter\.com|\/twitter\/)/i.test([item?.source, item?.link, item?.feedUrl, item?.homepage].filter(Boolean).join(' '));
}

function SourceForm({ onAdd, editingSource, onCancelEdit }: any) {
	const [url, setUrl] = useState('');
	const [source, setSource] = useState('');
	const [context, setContext] = useState('news');
	const [useTagTemplate, setUseTagTemplate] = useState(false);
	const [replaceTagValue, setReplaceTagValue] = useState('');
	const [testTag, setTestTag] = useState('');
	const [loading, setLoading] = useState(false);
	const [testing, setTesting] = useState(false);
	const [preview, setPreview] = useState<any>(null);
	const [testError, setTestError] = useState('');

	useEffect(() => {
		setPreview(null);
		setTestError('');
		if (editingSource) {
			setUrl(editingSource.urlTemplate || editingSource.url || editingSource.homepage || '');
			setSource(editingSource.source || '');
			setContext(editingSource.context || 'news');
			setUseTagTemplate(Boolean(editingSource.type === 'tag-template' || editingSource.urlTemplate));
			setReplaceTagValue(editingSource.replaceTagValue || '');
			setTestTag(editingSource.sampleTag || editingSource.templateTag || '');
		} else {
			setUrl('');
			setSource('');
			setContext('news');
			setUseTagTemplate(false);
			setReplaceTagValue('');
			setTestTag('');
		}
	}, [editingSource]);

	const handleTest = async () => {
		if (!url) return;
		setTesting(true);
		setPreview(null);
		setTestError('');
		try {
			const data = await testContextSource({
				url,
				useTagTemplate,
				urlTemplate: useTagTemplate ? url : undefined,
				replaceTagValue: useTagTemplate ? replaceTagValue : undefined,
				testTag: useTagTemplate ? testTag : undefined,
				sampleTag: useTagTemplate ? testTag : undefined,
			});
			setPreview(data);
			if (!source && data.title) {
				setSource(data.title);
			}
		} catch (err: any) {
			setTestError(err.message || 'Validation failed');
		} finally {
			setTesting(false);
		}
	};

	const handleSubmit = async (e: any) => {
		e.preventDefault();
		if (!url) return;
		setLoading(true);
		try {
			if (editingSource) {
				await updateContextSource(editingSource.url, {
					url,
					source,
					context,
					useTagTemplate,
					urlTemplate: useTagTemplate ? url : undefined,
					replaceTagValue: useTagTemplate ? replaceTagValue : undefined,
					testTag: useTagTemplate ? testTag : undefined,
					sampleTag: useTagTemplate ? testTag : undefined,
				});
				onCancelEdit();
			} else {
				await addContextSource({
					url,
					source,
					context,
					useTagTemplate,
					urlTemplate: useTagTemplate ? url : undefined,
					replaceTagValue: useTagTemplate ? replaceTagValue : undefined,
					testTag: useTagTemplate ? testTag : undefined,
					sampleTag: useTagTemplate ? testTag : undefined,
				});
			}
			setUrl('');
			setSource('');
			setUseTagTemplate(false);
			setReplaceTagValue('');
			setTestTag('');
			setPreview(null);
			onAdd();
		} catch (err: any) {
			alert(err.message || 'Failed to save source');
		} finally {
			setLoading(false);
		}
	};

	return (
		<form
			className='panel portal-card'
			onSubmit={handleSubmit}>
			<div className='portal-card-header'>
				<h3>{editingSource ? 'Edit Custom Source' : 'Add Custom Feed or Website Source'}</h3>
				{editingSource && (
					<button
						type='button'
						className='btn btn-ghost'
						onClick={onCancelEdit}
						style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
						Cancel
					</button>
				)}
			</div>

			<div className='portal-help-note'>
				<strong>Note:</strong> You can paste an RSS feed, platform URL, or a normal website page. Turn on <em>tag-based base URL</em> to save a reusable base like
				<code>https://x.com/search?q=</code> or <code>https://example.com/search?q={'{tag}'}</code>, then test it with different tags before saving. You can also paste a full URL
				like <code>https://x.com/search?q=tsla&amp;f=live</code> and mark <code>tsla</code> as the replaceable tag section.
			</div>

			<div className='form-grid'>
				<div className='form-field full-width'>
					<label>{useTagTemplate ? 'Base URL Template' : 'Feed or Website URL'}</label>
					<div style={{ display: 'flex', gap: '8px' }}>
						<input
							type='url'
							value={url}
							onChange={(e) => {
								setUrl(e.target.value);
								setPreview(null);
								setTestError('');
							}}
							placeholder={
								useTagTemplate ? 'https://x.com/search?q= or https://example.com/search?q={tag}' : 'https://example.com, https://example.com/blog, or https://example.com/feed.xml'
							}
							required
							style={{ flex: 1 }}
						/>
						<button
							type='button'
							className='btn btn-secondary'
							onClick={handleTest}
							disabled={testing || !url}
							style={{ padding: '0 12px' }}>
							{testing ? '...' : 'Test'}
						</button>
					</div>
				</div>

				<div className='form-field full-width'>
					<label style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<input
							type='checkbox'
							checked={useTagTemplate}
							onChange={(e) => {
								setUseTagTemplate(e.target.checked);
								setPreview(null);
								setTestError('');
							}}
						/>
						Use this as a tag-based base URL
					</label>
				</div>

				{useTagTemplate && (
					<>
						<div className='form-field full-width'>
							<label>Replace this part of the URL with the tag</label>
							<input
								type='text'
								value={replaceTagValue}
								onChange={(e) => {
									setReplaceTagValue(e.target.value);
									setPreview(null);
									setTestError('');
								}}
								placeholder='Optional: tsla'
							/>
						</div>
						<div className='form-field full-width'>
							<label>Test Tag</label>
							<input
								type='text'
								value={testTag}
								onChange={(e) => {
									setTestTag(e.target.value);
									setPreview(null);
									setTestError('');
								}}
								placeholder='gangstalking, #finra, $TSLA, etc.'
							/>
						</div>
					</>
				)}

				{testError && <div className='portal-test-error full-width'>{testError}</div>}

				{preview && (
					<div className='portal-test-preview full-width'>
						<div className='preview-header'>
							<strong>Valid: {preview.title}</strong>
							<span>({preview.itemCount} items found)</span>
						</div>
						<div
							className='portal-help-note'
							style={{ marginBottom: '8px' }}>
							{preview.usesTagTemplate ?
								`Tested base URL with tag "${preview.testTag}" → ${preview.testedUrl}`
							: preview.sourceType === 'website-feed' ?
								'Built custom feed from website HTML.'
							: preview.validationMethod === 'discovered-feed' ?
								"Found and resolved the website's linked feed automatically."
							:	'Validated as a direct feed/platform source.'}
						</div>
						{preview.usesTagTemplate && preview.baseUrl && (
							<div
								className='portal-help-note'
								style={{ marginBottom: '8px' }}>
								Template URL: <code>{preview.baseUrl}</code>
							</div>
						)}
						<div className='preview-items'>
							{preview.items.map((item: any, i: number) => (
								<div
									key={i}
									className='preview-item'>
									• {item.title}
								</div>
							))}
						</div>
					</div>
				)}

				<div className='form-field'>
					<label>Source Name (Optional)</label>
					<input
						type='text'
						value={source}
						onChange={(e) => setSource(e.target.value)}
						placeholder='e.g. BBC News'
					/>
				</div>
				<div className='form-field'>
					<label>Context</label>
					<select
						value={context}
						onChange={(e) => setContext(e.target.value)}
						className='portal-select'>
						<option value='news'>News (General)</option>
						<option value='research'>Research (Technical)</option>
					</select>
				</div>
			</div>
			<div
				className='form-actions'
				style={{ marginTop: '12px' }}>
				<button
					type='submit'
					className='btn btn-primary'
					disabled={loading}>
					{loading ?
						'Saving...'
					: editingSource ?
						'Update Source'
					:	'Add Source'}
				</button>
			</div>
		</form>
	);
}

function TagManager({ tags, onUpdate }: any) {
	const [newTag, setNewTag] = useState('');
	const [loading, setLoading] = useState(false);

	const handleAddTag = async (e: any) => {
		e.preventDefault();
		if (!newTag) return;
		setLoading(true);
		try {
			const res = await fetch('/api/context/tags', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tag: newTag }),
			});
			if (!res.ok) throw new Error('Failed to add tag');
			setNewTag('');
			onUpdate();
		} catch (err: any) {
			alert(err.message);
		} finally {
			setLoading(false);
		}
	};

	const handleRemoveTag = async (tag: string) => {
		try {
			const res = await fetch('/api/context/tags', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ tag }),
			});
			if (!res.ok) throw new Error('Failed to remove tag');
			onUpdate();
		} catch (err: any) {
			alert(err.message);
		}
	};

	return (
		<div className='panel portal-card'>
			<div className='portal-card-header'>
				<h3>Manage Tags (Generates URLs)</h3>
			</div>
			<form
				onSubmit={handleAddTag}
				className='context-tag-input-row'
				style={{ marginBottom: '12px' }}>
				<input
					type='text'
					value={newTag}
					onChange={(e) => setNewTag(e.target.value)}
					placeholder='Add tag (e.g. $AAPL, AI)'
				/>
				<button
					type='submit'
					className='btn btn-primary'
					disabled={loading}>
					+
				</button>
			</form>
			<div className='portal-tags-list'>
				{tags.map((tag: string) => (
					<span
						key={tag}
						className='portal-tag-pill is-active'>
						{tag}
						<button
							onClick={() => handleRemoveTag(tag)}
							className='portal-tag-remove'>
							×
						</button>
					</span>
				))}
			</div>
		</div>
	);
}

export default function PipelinePage() {
	const [data, setData] = useState<any>(null);
	const [monitorData, setMonitorData] = useState<any>({});
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [editingSource, setEditingSource] = useState<any>(null);
	const [tagFeedInput, setTagFeedInput] = useState('');
	const [hasInitializedTagFeedInput, setHasInitializedTagFeedInput] = useState(false);

	const loadData = async (forceRefresh = false) => {
		if (forceRefresh) setRefreshing(true);
		try {
			if (forceRefresh) {
				await fetchContextMonitor({ refresh: true });
			}
			const [portalData, monitorSnapshot] = await Promise.all([fetchContextPortal(), fetchContextMonitor()]);
			setData(portalData);
			setMonitorData(monitorSnapshot || {});
		} catch (err) {
			console.error(err);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	};

	useEffect(() => {
		loadData();

		const interval = setInterval(() => {
			fetchContextMonitor()
				.then((monitorSnapshot) => {
					if (monitorSnapshot) setMonitorData(monitorSnapshot);
				})
				.catch(console.error);
			fetchContextPortal()
				.then((portalData) => {
					if (portalData) setData(portalData);
				})
				.catch(console.error);
		}, 60000);
		return () => clearInterval(interval);
	}, []);

	useEffect(() => {
		if (!hasInitializedTagFeedInput && Array.isArray(data?.tags)) {
			setTagFeedInput(String(data.tags[0] || '').trim());
			setHasInitializedTagFeedInput(true);
		}
	}, [data, hasInitializedTagFeedInput]);

	const handleRemoveSource = async (url: string, isCustom: boolean) => {
		const message = isCustom ? 'Are you sure you want to remove this custom source?' : 'This is a built-in or generated source. Remove it from your catalog?';

		if (!confirm(message)) return;

		try {
			if (isCustom) {
				await removeContextSource(url);
			} else {
				await blockContextSource(url);
			}
			loadData();
		} catch (err: any) {
			alert(err.message || 'Failed to remove source');
		}
	};

	const handleRestoreSource = async (url: string) => {
		try {
			await unblockContextSource(url);
			loadData();
		} catch (err: any) {
			alert(err.message || 'Failed to restore source');
		}
	};

	const handleAddPipelineTag = async (tag: string) => {
		await addContextTags([tag]);
		setTagFeedInput(String(tag || '').trim());
		await loadData(true);
	};

	if (loading && !data) return <div className='portal-loading'>Loading Pipeline...</div>;

	const userAddedSources = Array.isArray(data?.sources?.userAdded) ? data.sources.userAdded : [];
	const activeTags = Array.isArray(data?.tags) ? data.tags : [];
	const templateBaseUrls = userAddedSources.filter((feed: any) => feed.type === 'tag-template').map((feed: any) => ({ ...feed, isTemplateConfigOnly: true }));
	const tagDrivenFeeds = Array.isArray(data?.catalog) ? data.catalog.filter((feed: any) => String(feed?.urlTemplate || feed?.parentUrl || '').trim()) : [];
	const standardCatalogFeeds = Array.isArray(data?.catalog) ? data.catalog.filter((feed: any) => !String(feed?.urlTemplate || feed?.parentUrl || '').trim()) : [];
	const liveFeedItems = Array.isArray(data?.output?.matches) ? data.output.matches : [];
	const selectedTagFeedValue = String(tagFeedInput || '').trim();
	const pipelineLaneTag = String(selectedTagFeedValue || '').trim();
	const normalizedSelectedTagFeedValue = normalizePortalTagValue(selectedTagFeedValue);
	const preferredTemplateBaseUrl = templateBaseUrls[0] || null;
	const testedTagDrivenFeed =
		tagDrivenFeeds.find((feed: any) => {
			const feedBaseUrl = String(feed?.urlTemplate || feed?.parentUrl || '').trim();
			const preferredBaseUrl = String(preferredTemplateBaseUrl?.url || '').trim();
			return Boolean(feedBaseUrl && preferredBaseUrl && feedBaseUrl === preferredBaseUrl);
		}) || null;
	const pipelineTagFeed = testedTagDrivenFeed;

	const pipelineItemFilter = (item: any) => {
		const itemMatchedKeywords = Array.isArray(item?.matchedKeywords) ? item.matchedKeywords.map((k: string) => normalizePortalTagValue(k)) : [];
		const targetTag = normalizePortalTagValue(selectedTagFeedValue);

		// More flexible tag matching (handle $ prefix mismatch between input and matched keywords)
		const tagMatch = itemMatchedKeywords.some((nk) => {
			return nk === targetTag || nk === `$${targetTag}` || (targetTag.startsWith('$') && nk === targetTag.slice(1));
		});

		if (!targetTag || !tagMatch) return false;

		const itemSource = String(item.source || '').toLowerCase();
		const isXSource = isXSourceItem(item);
		const isReddit = itemSource.includes('reddit');
		const isXLaneSelected = isXLaneFeed(pipelineTagFeed);

		// If we have a specific pipeline feed selected (like X Search), restrict the preview to that source family
		if (pipelineTagFeed) {
			const feedSource = String(pipelineTagFeed.source || '').toLowerCase();

			// Handle X Search specifically as requested - strictly X-only and NO REDDIT.
			if (isXLaneSelected) {
				if (isReddit) return false;
				return isXSource;
			}

			// For other sources, ensure we aren't showing Google News if it's not the target
			if (itemSource.includes('google news') && !feedSource.includes('google news')) {
				return false;
			}
		}

		// Fallback: prioritize X if the target looks like a cashtag, otherwise allow non-Google News
		if (targetTag.startsWith('$')) {
			if (isReddit) return false;
			return isXSource;
		}

		return !itemSource.includes('google news');
	};

	const pipelineTagBaseUrl = String(pipelineTagFeed?.urlTemplate || pipelineTagFeed?.parentUrl || preferredTemplateBaseUrl?.url || '').trim();
	const pipelineTagValue = String(selectedTagFeedValue || pipelineTagFeed?.templateTag || pipelineTagFeed?.sampleTag || '').trim();
	const pipelineTaggedUrl = buildTaggedTemplateUrl(pipelineTagBaseUrl, pipelineTagValue);
	const tagDrivenLiveFeedItems = liveFeedItems.filter(pipelineItemFilter);

	const renderLiveFeedCard = ({ title, items, meta, emptyMessage, keyPrefix }: { title: string; items: any[]; meta: any; emptyMessage: string; keyPrefix: string }) => (
		<div className='panel portal-card portal-live-feed-card'>
			<div className='portal-card-header'>
				<h3>{title}</h3>
			</div>
			<div className='portal-live-feed-body'>
				<div className='portal-live-feed-meta'>{meta}</div>
				<div className='context-ticker-window context-feed-window portal-live-feed-list'>
					<div className='context-ticker-track'>
						{items.map((item, index) => (
							<FeedCard
								key={item.id || item.link || item.title || `${keyPrefix}-${index}`}
								item={item}
								className='context-feed-stream-item'
								timestamp={formatArticleTimestamp(item.publishedAt, item.discoveredAt)}
								summaryClassName='context-feed-summary context-feed-summary-scroll'
								timestampClassName='context-notification-item-meta context-feed-timestamp'
							/>
						))}
						{!items.length && (
							<div className='context-empty-state-container'>
								<span className='context-empty-copy'>{emptyMessage}</span>
							</div>
						)}
					</div>
				</div>
			</div>
		</div>
	);

	const steps = [
		{ number: 1, title: 'Input Tags', description: 'User provides keywords or tickers ($TSLA, "AI", etc.)', active: data.tags.length > 0 },
		{ number: 2, title: 'Catalog Expansion', description: `Tags are expanded into ${data.catalog.length} potential RSS & search sources.`, active: data.catalog.length > 0 },
		{ number: 3, title: 'Feed Fetching', description: 'Server fetches items from each source in the catalog in parallel.', active: data.status.started },
		{ number: 4, title: 'Matching & Scoring', description: 'Content is scored against tags. Only high-relevance items are kept.', active: data.output.matches.length > 0 },
		{ number: 5, title: 'Unified RSS Output', description: 'Consolidated results are exposed as a single master RSS feed.', active: true },
	];

	return (
		<div className='dark-route-shell portal-dark-shell pipeline-dark-shell portal-shell'>
			<header className='portal-header'>
				<h1>RSS Builder Pipeline & Sources</h1>
				<div style={{ display: 'flex', gap: '8px' }}>
					<button
						className='btn btn-primary'
						onClick={() => loadData(true)}
						disabled={refreshing}>
						{refreshing ? 'Refreshing...' : 'Refresh Catalog Now'}
					</button>
					<a
						href='/rss-portal'
						className='btn btn-secondary'>
						View Portal
					</a>
				</div>
			</header>

			<div className='pipeline-layout'>
				<div className='pipeline-column'>
					<div className='panel portal-card'>
						<div className='portal-card-header'>
							<h3>Pipeline Flow</h3>
						</div>
						<div className='pipeline-flow'>
							{steps.map((step) => (
								<PipelineStep
									key={step.number}
									{...step}
								/>
							))}
						</div>
					</div>

					<ContextFeedColumn
						columnKey='pipeline'
						monitor={monitorData}
						activeTag={pipelineLaneTag}
						contextFilter='all'
						columnTitle='Tag Lane'
						showComposer={true}
						allowActiveTagClear={true}
						onClearActiveTag={() => setTagFeedInput('')}
						onSelectTag={(tag: string) => setTagFeedInput(String(tag || '').trim())}
						onAddTag={handleAddPipelineTag}
						draftTagValue={tagFeedInput}
						onDraftTagChange={(tag: string) => setTagFeedInput(tag)}
						itemFilter={pipelineItemFilter}
					/>

					{pipelineTagBaseUrl && (
						<div className='panel portal-card'>
							<div className='portal-card-header'>
								<h3>Tag Feed Template</h3>
							</div>
							<div className='portal-tag-feed-live-preview'>
								<div className='portal-item-url'>{`Base URL: ${pipelineTagBaseUrl}`}</div>
								{pipelineTaggedUrl && (
									<div className='portal-item-url portal-item-url-secondary'>
										<span>Tagged URL: </span>
										<a
											href={pipelineTaggedUrl}
											target='_blank'
											rel='noreferrer'
											className='portal-item-url-link'>
											{pipelineTaggedUrl}
										</a>
									</div>
								)}
								<div className='portal-item-stats'>
									{pipelineTagValue && <span>Tag: {pipelineTagValue}</span>}
									{tagDrivenLiveFeedItems.length > 0 && <span>{tagDrivenLiveFeedItems.length} matching live items</span>}
								</div>
							</div>
						</div>
					)}

					<TagManager
						tags={data.tags}
						onUpdate={loadData}
					/>
					<SourceForm
						onAdd={loadData}
						editingSource={editingSource}
						onCancelEdit={() => setEditingSource(null)}
					/>
				</div>

				<div className='pipeline-column portal-column-wide'>
					{templateBaseUrls.length > 0 && (
						<div className='panel portal-card'>
							<div className='portal-card-header'>
								<h3>Tag-Based Base URLs</h3>
							</div>
							<div className='portal-list portal-list-large'>
								{templateBaseUrls.map((feed: any, index: number) => {
									const health = data.feedHealth[feed.url] || {};

									return (
										<div
											key={`template-${index}`}
											className='portal-list-item'>
											<div className='portal-item-main'>
												<div className='portal-item-url'>{`Base URL: ${feed.url}`}</div>
												{health.lastError && <div className='portal-item-error-msg'>Error: {health.lastError}</div>}
											</div>
											<div
												className='portal-item-actions'
												style={{ display: 'flex', gap: '4px' }}>
												<button
													className='btn btn-secondary'
													onClick={() => setEditingSource(feed)}
													style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
													Edit
												</button>
												<button
													className='btn btn-remove'
													onClick={() => handleRemoveSource(feed.url, true)}
													style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
													Remove
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					{tagDrivenFeeds.length > 0 && (
						<div className='panel portal-card'>
							<div className='portal-card-header'>
								<h3>Tag-Driven Feeds</h3>
							</div>
							<div className='portal-tag-feed-controls'>
								<label htmlFor='tag-feed-input'>Tag for tag-based feeds</label>
								<div className='context-tag-input-row'>
									<input
										id='tag-feed-input'
										type='text'
										value={tagFeedInput}
										onChange={(e) => setTagFeedInput(e.target.value)}
										placeholder='$tsla'
									/>
								</div>
								<div className='portal-tag-feed-note'>
									Use this tag to preview feeds built from a base URL like <code>https://x.com/search?q={'{tag}'}&amp;f=live</code>. Preview updates instantly as you type.
								</div>
							</div>
							<div className='portal-list portal-list-large'>
								{tagDrivenFeeds.map((feed: any, index: number) => {
									const customSource = userAddedSources.find((f: any) => f.url === feed.url || f.url === feed.parentUrl);
									const isCustom = Boolean(customSource);
									const baseUrl = String(feed.urlTemplate || feed.parentUrl || '').trim();
									const previewTag = String(selectedTagFeedValue || feed.templateTag || feed.sampleTag || '').trim();
									const taggedUrl = baseUrl && previewTag ? buildTaggedTemplateUrl(baseUrl, previewTag) : '';
									const health = data.feedHealth[feed.url] || {};
									const isHealthy = health.lastSuccessAt && (!health.lastErrorAt || new Date(health.lastSuccessAt) > new Date(health.lastErrorAt));
									const statusLabel =
										refreshing ? 'Updating...'
										: health.lastError ? 'Error'
										: health.lastSuccessAt ? 'Healthy'
										: 'Pending';

									return (
										<div
											key={`tag-driven-${feed.url || feed.parentUrl || feed.source || index}`}
											className='portal-list-item'>
											<div className='portal-item-main'>
												<div className='portal-item-title'>
													{feed.source}{' '}
													<span
														className={`health-pill ${
															refreshing ? 'is-pending'
															: isHealthy ? 'is-healthy'
															: health.lastError ? 'is-error'
															: 'is-pending'
														}`}>
														{statusLabel}
													</span>
												</div>
												<div className='portal-item-url'>{`Base URL: ${baseUrl}`}</div>
												{taggedUrl && (
													<div className='portal-item-url portal-item-url-secondary'>
														<span>Tagged URL: </span>
														<a
															href={taggedUrl}
															target='_blank'
															rel='noreferrer'
															className='portal-item-url-link'>
															{taggedUrl}
														</a>
													</div>
												)}
												{feed.url !== taggedUrl && (
													<div className='portal-item-url portal-item-url-secondary'>
														<span>Fetch URL: </span>
														<span>{feed.url}</span>
													</div>
												)}
												<div className='portal-item-stats'>
													{previewTag && <span>Tag: {previewTag}</span>}
													{health.itemCount !== undefined && <span>{health.itemCount} items</span>}
													{health.successCount > 0 && <span>{health.successCount} fetches</span>}
													{health.errorCount > 0 && <span className='stat-error'>{health.errorCount} failures</span>}
													{health.lastSuccessAt && <span>Last: {new Date(health.lastSuccessAt).toLocaleTimeString()}</span>}
												</div>
												{health.lastError && <div className='portal-item-error-msg'>Error: {health.lastError}</div>}
											</div>
											<div
												className='portal-item-actions'
												style={{ display: 'flex', gap: '4px' }}>
												{isCustom ?
													<>
														<button
															className='btn btn-secondary'
															onClick={() => setEditingSource(customSource)}
															style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
															Edit
														</button>
														<button
															className='btn btn-remove'
															onClick={() => handleRemoveSource(customSource.url, true)}
															style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
															Remove
														</button>
													</>
												:	<button
														className='btn btn-remove'
														onClick={() => handleRemoveSource(feed.url, false)}
														style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
														Remove
													</button>
												}
											</div>
										</div>
									);
								})}
							</div>
						</div>
					)}

					<div className='panel portal-card'>
						<div className='portal-card-header'>
							<h3>Active Catalog</h3>
						</div>
						<div className='portal-list portal-list-large'>
							{standardCatalogFeeds.map((feed: any, index: number) => {
								const customSource = userAddedSources.find((f: any) => f.url === feed.url || f.url === feed.parentUrl);
								const isCustom = Boolean(customSource);
								const baseUrl = String(feed.urlTemplate || feed.parentUrl || '').trim();
								const previewTag = String(feed.templateTag || feed.sampleTag || activeTags[0] || '').trim();
								const taggedUrl = baseUrl && previewTag ? buildTaggedTemplateUrl(baseUrl, previewTag) : '';
								const displayBaseUrl = Boolean(baseUrl && taggedUrl);
								const health = data.feedHealth[feed.url] || {};
								const isHealthy = health.lastSuccessAt && (!health.lastErrorAt || new Date(health.lastSuccessAt) > new Date(health.lastErrorAt));
								const statusLabel =
									refreshing ? 'Updating...'
									: health.lastError ? 'Error'
									: health.lastSuccessAt ? 'Healthy'
									: 'Pending';

								return (
									<div
										key={index}
										className='portal-list-item'>
										<div className='portal-item-main'>
											<div className='portal-item-title'>
												{feed.source}{' '}
												<span
													className={`health-pill ${
														refreshing ? 'is-pending'
														: isHealthy ? 'is-healthy'
														: health.lastError ? 'is-error'
														: 'is-pending'
													}`}>
													{statusLabel}
												</span>
											</div>
											<div className='portal-item-url'>{displayBaseUrl ? `Base URL: ${baseUrl}` : feed.url}</div>
											{taggedUrl && taggedUrl !== feed.url && (
												<div className='portal-item-url portal-item-url-secondary'>
													<span>Tagged URL: </span>
													<a
														href={taggedUrl}
														target='_blank'
														rel='noreferrer'
														className='portal-item-url-link'>
														{taggedUrl}
													</a>
												</div>
											)}
											{displayBaseUrl && feed.url !== taggedUrl && (
												<div className='portal-item-url portal-item-url-secondary'>
													<span>Fetch URL: </span>
													<span>{feed.url}</span>
												</div>
											)}
											<div className='portal-item-stats'>
												{feed.templateTag && <span>Tag: {feed.templateTag}</span>}
												{feed.sampleTag && !feed.templateTag && <span>Sample tag: {feed.sampleTag}</span>}
												{health.itemCount !== undefined && <span>{health.itemCount} items</span>}
												{health.successCount > 0 && <span>{health.successCount} fetches</span>}
												{health.errorCount > 0 && <span className='stat-error'>{health.errorCount} failures</span>}
												{health.lastSuccessAt && <span>Last: {new Date(health.lastSuccessAt).toLocaleTimeString()}</span>}
											</div>
											{health.lastError && <div className='portal-item-error-msg'>Error: {health.lastError}</div>}
										</div>
										<div
											className='portal-item-actions'
											style={{ display: 'flex', gap: '4px' }}>
											{isCustom ?
												<>
													<button
														className='btn btn-secondary'
														onClick={() => setEditingSource(customSource)}
														style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
														Edit
													</button>
													<button
														className='btn btn-remove'
														onClick={() => handleRemoveSource(customSource.url, true)}
														style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
														Remove
													</button>
												</>
											:	<button
													className='btn btn-remove'
													onClick={() => handleRemoveSource(feed.url, false)}
													style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
													Remove
												</button>
											}
										</div>
									</div>
								);
							})}
						</div>
					</div>

					{data.sources.blocked?.length > 0 && (
						<div className='panel portal-card'>
							<div className='portal-card-header'>
								<h3>Restricted / Blocked Sources</h3>
							</div>
							<div className='portal-list'>
								{data.sources.blocked.map((url: string, index: number) => (
									<div
										key={index}
										className='portal-list-item'>
										<div className='portal-item-main'>
											<div className='portal-item-url'>{url}</div>
										</div>
										<div className='portal-item-actions'>
											<button
												className='btn btn-secondary'
												onClick={() => handleRestoreSource(url)}
												style={{ padding: '2px 8px', fontSize: '0.7rem' }}>
												Restore
											</button>
										</div>
									</div>
								))}
							</div>
						</div>
					)}

					<div className='panel portal-card'>
						<div className='portal-card-header'>
							<h3>Current Master RSS Output</h3>
						</div>
						<div className='portal-stat portal-stat-full'>
							<code className='portal-url-code'>http://localhost:3001/api/context/rss</code>
						</div>
					</div>
				</div>

				<div className='pipeline-column pipeline-column-live'>
					{renderLiveFeedCard({
						title: 'Live Feed',
						items: liveFeedItems,
						meta: (
							<>
								<span>{liveFeedItems.length} live items</span>
								{activeTags.length > 0 && <span>{activeTags.length} active tags</span>}
							</>
						),
						emptyMessage: 'No live items found yet matching your tags.',
						keyPrefix: 'live-feed',
					})}
				</div>

				<div className='pipeline-column pipeline-column-tag-preview'>
					{renderLiveFeedCard({
						title: 'Live Tag Preview',
						items: tagDrivenLiveFeedItems,
						meta: (
							<>
								<span>{selectedTagFeedValue || 'No tag selected'}</span>
								<span>{tagDrivenLiveFeedItems.length} matching live items</span>
							</>
						),
						emptyMessage: selectedTagFeedValue ? 'No live items yet for this tag. Try refreshing the catalog.' : 'Enter a tag to start the live tag preview.',
						keyPrefix: 'tag-live-feed',
					})}
				</div>
			</div>
		</div>
	);
}
