'use client';

import { useEffect, useState } from 'react';
import {
	addContextSource,
	fetchContextMonitor,
	fetchContextPortal,
	removeContextSource,
	updateContextSource,
	testContextSource,
	blockContextSource,
	unblockContextSource,
	replaceContextTags,
} from '../../api';
import FeedCard from '../../components/FeedCard';
import '../../style.css';

export default function SSEDashboardPage() {
	const [portal, setPortal] = useState<any>(null);
	const [monitor, setMonitor] = useState<any>({});
	const [leftTag, setLeftTag] = useState('');
	const [researchTag, setResearchTag] = useState('');
	const [rssSnapshot, setRssSnapshot] = useState<any>(null);
	const [crawlSnapshot, setCrawlSnapshot] = useState<any>(null);
	const [loading, setLoading] = useState(true);
	const [refreshing, setRefreshing] = useState(false);
	const [editingSource, setEditingSource] = useState<any>(null);
	const [form, setForm] = useState({ url: '', source: '', context: 'news', useTagTemplate: false, replaceTagValue: '', testTag: '' });
	const [testingPreview, setTestingPreview] = useState<any>(null);

	const load = async (force = false) => {
		if (force) setRefreshing(true);
		try {
			if (force) await fetchContextMonitor({ refresh: true });
			const [p, m] = await Promise.all([fetchContextPortal(), fetchContextMonitor()]);
			setPortal(p || {});
			// initialize tag inputs from portal
			const portalTags =
				Array.isArray(p?.tags) ? p.tags
				: Array.isArray(p?.tags) ? p.tags
				: [];
			setLeftTag(portalTags[0] || '');
			setResearchTag(portalTags[1] || '');
			setMonitor(m || {});
		} catch (err) {
			console.error(err);
		} finally {
			setLoading(false);
			setRefreshing(false);
		}
	};

	useEffect(() => {
		load();
		const id = setInterval(() => {
			fetchContextMonitor()
				.then((m) => setMonitor(m))
				.catch(console.error);
			fetchContextPortal()
				.then((p) => {
					if (p == null) {
						setPortal(p as any);
						return;
					}
					setPortal(p as any);
					const portalTags = Array.isArray((p as any).tags) ? (p as any).tags : [];
					setLeftTag(portalTags[0] || '');
					setResearchTag(portalTags[1] || '');
				})
				.catch(console.error);
		}, 60000);

		// Open family-specific SSE streams for live side-by-side compare
		const CONTEXT_BASE = (process.env.NEXT_PUBLIC_CONTEXT_API_URL as string) || 'http://localhost:3001';
		let rssStream: EventSource | null = null;
		let crawlStream: EventSource | null = null;

		function applyDiffToSnapshot(snapshot: any, diff: any) {
			if (!snapshot) return snapshot;
			const next = JSON.parse(JSON.stringify(snapshot));
			const matches = Array.isArray(next.output?.matches) ? [...next.output.matches] : [];
			const map = new Map(matches.map((m: any) => [String(m.id), m]));
			if (diff?.removed && Array.isArray(diff.removed)) {
				for (const id of diff.removed) map.delete(String(id));
			}
			if (diff?.added && Array.isArray(diff.added)) {
				for (const item of diff.added) if (item && item.id) map.set(String(item.id), item);
			}
			if (diff?.updated && Array.isArray(diff.updated)) {
				for (const item of diff.updated) if (item && item.id) map.set(String(item.id), item);
			}
			next.output = next.output || {};
			next.output.matches = Array.from(map.values());
			return next;
		}

		try {
			rssStream = new EventSource(`${CONTEXT_BASE}/api/context/rss-stream`);
			rssStream.addEventListener('snapshot', (e: any) => {
				try {
					const payload = JSON.parse(e.data);
					setRssSnapshot(payload.snapshot || payload);
				} catch (err) {
					console.error('rss snapshot parse', err);
				}
			});
			rssStream.addEventListener('diff', (e: any) => {
				try {
					const payload = JSON.parse(e.data);
					setRssSnapshot((prev: any) => applyDiffToSnapshot(prev, payload.diff || payload.data?.diff || {}));
				} catch (err) {
					console.error('rss diff parse', err);
				}
			});

			crawlStream = new EventSource(`${CONTEXT_BASE}/api/context/crawl-stream`);
			crawlStream.addEventListener('snapshot', (e: any) => {
				try {
					const payload = JSON.parse(e.data);
					setCrawlSnapshot(payload.snapshot || payload);
				} catch (err) {
					console.error('crawl snapshot parse', err);
				}
			});
			crawlStream.addEventListener('diff', (e: any) => {
				try {
					const payload = JSON.parse(e.data);
					setCrawlSnapshot((prev: any) => applyDiffToSnapshot(prev, payload.diff || payload.data?.diff || {}));
				} catch (err) {
					console.error('crawl diff parse', err);
				}
			});
		} catch (err) {
			console.error('Failed to open family SSE streams', err);
		}

		return () => {
			clearInterval(id);
			try {
				rssStream?.close();
			} catch (e) {}
			try {
				crawlStream?.close();
			} catch (e) {}
		};
	}, []);

	const builtin = Array.isArray(portal?.catalog) ? portal.catalog : [];
	const userAdded = Array.isArray(portal?.sources?.userAdded) ? portal.sources.userAdded : [];
	const blocked = Array.isArray(portal?.sources?.blocked) ? portal.sources.blocked : [];
	// live snapshots from family SSEs (fallback to portal payload when not available)
	const rssMatches =
		Array.isArray(rssSnapshot?.output?.matches) ? rssSnapshot.output.matches
		: Array.isArray(portal?.output?.generalNews) && portal.output.generalNews.length > 0 ? portal.output.generalNews
		: Array.isArray(portal?.output?.matches) ? portal.output.matches
		: [];

	// sampleFeed removed — left column no longer shows a sample feed

	const crawlMatchesAll =
		Array.isArray(crawlSnapshot?.output?.matches) ? crawlSnapshot.output.matches
		: Array.isArray(portal?.output?.matches) ? portal.output.matches
		: [];
	function isRedditItem(item: any) {
		try {
			const src = String(item?.source || '') + ' ' + String(item?.feedUrl || '') + ' ' + String(item?.homepage || '') + ' ' + String(item?.link || '');
			if (/reddit\.com|\breddit\b|redd\.it/i.test(src)) return true;
			if (Array.isArray(item?.tags) && item.tags.some((t: any) => String(t).toLowerCase().includes('reddit'))) return true;
		} catch (e) {}
		return false;
	}

	const crawlResearchMatches = crawlMatchesAll.filter((m: any) => String(m?.context || '').toLowerCase() === 'research' && !isRedditItem(m));

	const [formRight, setFormRight] = useState({ url: '', source: '' });
	const [editingRight, setEditingRight] = useState<any>(null);

	const resetForm = () => setForm({ url: '', source: '', context: 'news', useTagTemplate: false, replaceTagValue: '', testTag: '' });

	const handleTest = async () => {
		if (!form.url) return;
		setTestingPreview(null);
		try {
			const data = await testContextSource({
				url: form.url,
				useTagTemplate: form.useTagTemplate,
				urlTemplate: form.useTagTemplate ? form.url : undefined,
				replaceTagValue: form.replaceTagValue,
				testTag: form.testTag,
				sampleTag: form.testTag,
			});
			setTestingPreview(data);
		} catch (err: any) {
			setTestingPreview({ error: err.message || String(err) });
		}
	};

	const handleSubmit = async (e: any) => {
		e?.preventDefault();
		try {
			if (editingSource) {
				await updateContextSource(editingSource.url || editingSource, { ...editingSource, ...form });
			} else {
				await addContextSource({ ...form });
			}
			resetForm();
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed to save source');
		}
	};

	const handleRemove = async (url: string, isCustom = false) => {
		try {
			if (isCustom) await removeContextSource(url);
			else await blockContextSource(url);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed to remove');
		}
	};

	const handleEdit = (s: any) => {
		setEditingSource(s);
		setForm({ url: s.url || '', source: s.source || '', context: s.context || 'news', useTagTemplate: !!s.urlTemplate, replaceTagValue: s.replaceTagValue || '', testTag: '' });
	};

	const handleEditRight = (s: any) => {
		setEditingRight(s);
		setFormRight({ url: s.url || '', source: s.source || '' });
	};

	const handleSubmitRight = async (e: any) => {
		e?.preventDefault();
		try {
			if (editingRight) {
				await updateContextSource(editingRight.url || editingRight, { ...editingRight, ...formRight });
			} else {
				await addContextSource({ ...formRight, context: 'crawl' });
			}
			setFormRight({ url: '', source: '' });
			setEditingRight(null);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed to save source');
		}
	};

	const handleUnblock = async (url: string) => {
		try {
			await unblockContextSource(url);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed to unblock');
		}
	};

	if (loading) return <div className='portal-loading'>Loading SSE Dashboard...</div>;

	return (
		<div className='dark-route-shell portal-dark-shell'>
			<div
				className='portal-two-column'
				style={{ display: 'flex', gap: 16 }}>
				<div
					className='portal-column'
					style={{ flex: 1 }}>
					<section className='panel portal-card'>
						<h3>Status & Config (Fast RSS)</h3>
						<div>Started: {portal?.status?.started ? 'yes' : 'no'}</div>
						<div>Stream version: {portal?.status?.streamVersion}</div>
						<div>Feeds: {portal?.status?.feedCount}</div>
						<div style={{ marginTop: 12 }}>
							<label style={{ display: 'block', marginBottom: 6 }}>Primary Tag (left lanes)</label>
							<input
								type='text'
								value={leftTag}
								onChange={(e) => setLeftTag(e.target.value)}
								style={{ width: '100%', marginBottom: 8 }}
							/>
							<div style={{ display: 'flex', gap: 8 }}>
								<button
									className='btn btn-primary'
									onClick={async () => {
										try {
											const tags = [leftTag, researchTag].filter(Boolean);
											await replaceContextTags(tags);
											await load(true);
										} catch (err: any) {
											alert(err?.message || 'Failed to set tags');
										}
									}}>
									Set Left Tags
								</button>
								<button
									className='btn btn-secondary'
									onClick={async () => {
										setLeftTag('');
										try {
											const tags = [researchTag].filter(Boolean);
											await replaceContextTags(tags);
											await load(true);
										} catch (err: any) {
											alert(err?.message || 'Failed to clear tag');
										}
									}}>
									Clear
								</button>
							</div>
						</div>
						<div>
							RSS items:{' '}
							{Array.isArray(portal?.output?.matches) ?
								portal.output.matches.filter((item: any) => {
									const src = String(item.discoverySource || item.source || item.feedUrl || '').toLowerCase();
									if (String(item.discoverySource || '').toLowerCase() === 'rss') return true;
									if (/\b(rss|feed|google news|wired|investing|news)\b/.test(src)) return true;
									if (String(item.parentUrl || item.link || '').match(/(\.rss$|\/feed(?:$|\/)|\.xml$)/i)) return true;
									return false;
								}).length
							:	0}
						</div>
					</section>

					<section className='panel portal-card'>
						<h3>Add / Edit RSS Source</h3>
						<form
							onSubmit={handleSubmit}
							className='form-grid'>
							<div className='form-field full-width'>
								<label>URL or Template</label>
								<input
									type='url'
									value={form.url}
									onChange={(e) => setForm((s) => ({ ...s, url: e.target.value }))}
									required
								/>
							</div>
							<div className='form-field'>
								<label>Source name</label>
								<input
									value={form.source}
									onChange={(e) => setForm((s) => ({ ...s, source: e.target.value }))}
								/>
							</div>
							<div className='form-actions'>
								<button
									className='btn btn-secondary'
									type='button'
									onClick={handleTest}>
									Test
								</button>
								<button
									className='btn btn-primary'
									type='submit'>
									{editingSource ? 'Update' : 'Add'}
								</button>
							</div>
						</form>
						{testingPreview && (
							<div className='portal-test-preview'>
								{testingPreview.error ?
									<div className='portal-test-error'>{testingPreview.error}</div>
								:	<div>
										<strong>{testingPreview.title}</strong>
										<div>{testingPreview.itemCount} items</div>
									</div>
								}
							</div>
						)}
					</section>

					<section className='panel portal-card portal-sources'>
						<h3>Builtin Catalog (RSS samples)</h3>
						<div className='portal-list'>
							{builtin.slice(0, 20).map((f: any, i: number) => (
								<div
									key={`${f.url || f.source}-${i}`}
									className='portal-list-item'>
									<div className='portal-item-main'>
										<div className='portal-item-title'>{f.source}</div>
										<div className='portal-item-url'>{f.url || f.homepage || ''}</div>
									</div>
									<div className='portal-item-actions'>
										<button
											className='btn btn-remove'
											onClick={() => handleRemove(f.url || f.homepage, false)}>
											Remove
										</button>
									</div>
								</div>
							))}
						</div>
					</section>

					{/* Sample feed removed */}

					{/* Moved from Pipeline: Catalog & Feeds (bottom-left) */}
					<section className='panel portal-card'>
						<h3>Catalog (moved from Pipeline)</h3>
						{(() => {
							const portalUserAdded = Array.isArray(portal?.sources?.userAdded) ? portal.sources.userAdded : [];
							const templateBaseUrls = portalUserAdded.filter((f: any) => f.type === 'tag-template');
							const tagDrivenFeeds = Array.isArray(portal?.catalog) ? portal.catalog.filter((feed: any) => String(feed?.urlTemplate || feed?.parentUrl || '').trim()) : [];
							const standardCatalogFeeds = Array.isArray(portal?.catalog) ? portal.catalog.filter((feed: any) => !String(feed?.urlTemplate || feed?.parentUrl || '').trim()) : [];
							return (
								<div>
									{templateBaseUrls.length > 0 && (
										<div className='portal-list portal-list-large'>
											{templateBaseUrls.map((feed: any, index: number) => (
												<div
													key={`template-moved-${index}`}
													className='portal-list-item'>
													<div className='portal-item-main'>
														<div className='portal-item-url'>{`Base URL: ${feed.url}`}</div>
													</div>
													<div className='portal-item-actions'>
														<button
															className='btn btn-secondary'
															onClick={() => handleEdit(feed)}>
															Edit
														</button>
														<button
															className='btn btn-remove'
															onClick={() => handleRemove(feed.url, true)}>
															Remove
														</button>
													</div>
												</div>
											))}
										</div>
									)}

									{tagDrivenFeeds.length > 0 && (
										<div className='portal-list portal-list-large'>
											{tagDrivenFeeds.map((feed: any, index: number) => (
												<div
													key={`tag-driven-moved-${index}`}
													className='portal-list-item'>
													<div className='portal-item-main'>
														<div className='portal-item-title'>{feed.source}</div>
														<div className='portal-item-url'>{feed.url || feed.parentUrl}</div>
													</div>
													<div className='portal-item-actions'>
														<button
															className='btn btn-secondary'
															onClick={() => handleEdit(feed)}>
															Edit
														</button>
														<button
															className='btn btn-remove'
															onClick={() => handleRemove(feed.url, false)}>
															Remove
														</button>
													</div>
												</div>
											))}
										</div>
									)}

									{standardCatalogFeeds.length > 0 && (
										<div className='portal-list portal-list-large'>
											{standardCatalogFeeds.map((feed: any, index: number) => (
												<div
													key={`standard-catalog-moved-${index}`}
													className='portal-list-item'>
													<div className='portal-item-main'>
														<div className='portal-item-title'>{feed.source}</div>
														<div className='portal-item-url'>{feed.url}</div>
													</div>
													<div className='portal-item-actions'>
														<button
															className='btn btn-secondary'
															onClick={() => handleEdit(feed)}>
															Edit
														</button>
														<button
															className='btn btn-remove'
															onClick={() => handleRemove(feed.url, false)}>
															Remove
														</button>
													</div>
												</div>
											))}
										</div>
									)}

									{Array.isArray(portal?.sources?.blocked) && portal.sources.blocked.length > 0 && (
										<div>
											<h4>Blocked Sources</h4>
											<div className='portal-list'>
												{portal.sources.blocked.map((u: string, i: number) => (
													<div
														key={`blocked-moved-${i}`}
														className='portal-list-item'>
														<div className='portal-item-main'>
															<div className='portal-item-url'>{u}</div>
														</div>
														<div className='portal-item-actions'>
															<button
																className='btn btn-secondary'
																onClick={() => handleUnblock(u)}>
																Unblock
															</button>
														</div>
													</div>
												))}
											</div>
										</div>
									)}

									<div style={{ marginTop: 12 }}>
										<strong>Master RSS Output</strong>
										<div>
											<code className='portal-url-code'>http://localhost:3001/api/context/rss</code>
										</div>
									</div>
								</div>
							);
						})()}
					</section>

					{/* Live Feed removed per request */}
				</div>

				<div
					className='portal-column'
					style={{ flex: 1 }}>
					<section className='panel portal-card'>
						<h3>Status & Config (Crawl)</h3>
						<div>Started: {portal?.status?.started ? 'yes' : 'no'}</div>
						<div>Stream version: {portal?.status?.streamVersion}</div>
						<div>Feeds: {portal?.status?.feedCount}</div>
						<div style={{ marginTop: 12 }}>
							<label style={{ display: 'block', marginBottom: 6 }}>Research Tag (right lane)</label>
							<input
								type='text'
								value={researchTag}
								onChange={(e) => setResearchTag(e.target.value)}
								style={{ width: '100%', marginBottom: 8 }}
							/>
							<div style={{ display: 'flex', gap: 8 }}>
								<button
									className='btn btn-primary'
									onClick={async () => {
										try {
											const tags = [leftTag, researchTag].filter(Boolean);
											await replaceContextTags(tags);
											await load(true);
										} catch (err: any) {
											alert(err?.message || 'Failed to set research tag');
										}
									}}>
									Set Research Tag
								</button>
								<button
									className='btn btn-secondary'
									onClick={async () => {
										setResearchTag('');
										try {
											const tags = [leftTag].filter(Boolean);
											await replaceContextTags(tags);
											await load(true);
										} catch (err: any) {
											alert(err?.message || 'Failed to clear tag');
										}
									}}>
									Clear
								</button>
							</div>
						</div>
					</section>
					{/* Research lane removed per request */}
					<section className='panel portal-card portal-sources'>
						<h3>User Sources (Crawl)</h3>
						<form
							onSubmit={handleSubmitRight}
							className='form-grid'>
							<div className='form-field full-width'>
								<label>URL</label>
								<input
									type='url'
									value={formRight.url}
									onChange={(e) => setFormRight((s) => ({ ...s, url: e.target.value }))}
									required
								/>
							</div>
							<div className='form-field'>
								<label>Source name</label>
								<input
									value={formRight.source}
									onChange={(e) => setFormRight((s) => ({ ...s, source: e.target.value }))}
								/>
							</div>
							<div className='form-actions'>
								<button
									className='btn btn-primary'
									type='submit'>
									{editingRight ? 'Update' : 'Add'}
								</button>
								{editingRight && (
									<button
										type='button'
										className='btn btn-secondary'
										onClick={() => {
											setEditingRight(null);
											setFormRight({ url: '', source: '' });
										}}>
										Cancel
									</button>
								)}
							</div>
						</form>

						<div
							className='portal-list portal-list-large'
							style={{ marginTop: 12 }}>
							{/* Builtin sources */}
							{Array.isArray(portal?.sources?.builtin) &&
								portal.sources.builtin.map((feed: any, i: number) => (
									<div
										key={`builtin-${i}`}
										className='portal-list-item'>
										<div className='portal-item-main'>
											<div className='portal-item-title'>{feed.source}</div>
											<div className='portal-item-url'>{feed.url || feed.homepage || ''}</div>
										</div>
										<div className='portal-item-actions'>
											<button
												className='btn btn-remove'
												onClick={() => handleRemove(feed.url || feed.homepage, false)}>
												Remove
											</button>
										</div>
									</div>
								))}

							{/* User-added (editable) */}
							{Array.isArray(portal?.sources?.userAdded) &&
								portal.sources.userAdded.map((feed: any, i: number) => (
									<div
										key={`user-${i}`}
										className='portal-list-item'>
										<div className='portal-item-main'>
											<div className='portal-item-title'>{feed.source}</div>
											<div className='portal-item-url'>{feed.url || feed.homepage || ''}</div>
										</div>
										<div className='portal-item-actions'>
											<button
												className='btn btn-secondary'
												onClick={() => handleEditRight(feed)}>
												Edit
											</button>
											<button
												className='btn btn-remove'
												onClick={() => handleRemove(feed.url, true)}>
												Remove
											</button>
										</div>
									</div>
								))}

							{/* Generated catalog entries */}
							{Array.isArray(portal?.catalog) &&
								portal.catalog.map((feed: any, i: number) => (
									<div
										key={`catalog-${i}`}
										className='portal-list-item'>
										<div className='portal-item-main'>
											<div className='portal-item-title'>{feed.source}</div>
											<div className='portal-item-url'>{feed.url || feed.parentUrl || ''}</div>
										</div>
										<div className='portal-item-actions'>
											<button
												className='btn btn-remove'
												onClick={() => handleRemove(feed.url || feed.parentUrl, false)}>
												Remove
											</button>
										</div>
									</div>
								))}
						</div>

						{Array.isArray(portal?.sources?.blocked) && portal.sources.blocked.length > 0 && (
							<div style={{ marginTop: 12 }}>
								<h4>Blocked Sources</h4>
								<div className='portal-list'>
									{portal.sources.blocked.map((u: string, i: number) => (
										<div
											key={`blocked-moved-${i}`}
											className='portal-list-item'>
											<div className='portal-item-main'>
												<div className='portal-item-url'>{u}</div>
											</div>
											<div className='portal-item-actions'>
												<button
													className='btn btn-secondary'
													onClick={() => handleUnblock(u)}>
													Unblock
												</button>
											</div>
										</div>
									))}
								</div>
							</div>
						)}

						<div style={{ marginTop: 12 }}>
							<strong>Master RSS Output</strong>
							<div>
								<code className='portal-url-code'>http://localhost:3001/api/context/rss</code>
							</div>
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
