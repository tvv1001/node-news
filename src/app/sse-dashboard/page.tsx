'use client';

import { useEffect, useState } from 'react';
import {
	fetchContextPortal,
	fetchContextMonitor,
	addContextSource,
	updateContextSource,
	removeContextSource,
	testContextSource,
	blockContextSource,
	unblockContextSource,
	addContextTags,
	removeContextTags,
} from '../../api';
import FeedCard from '../../components/FeedCard';
import '../../style.css';

export default function SSEDashboardPage() {
	const [portal, setPortal] = useState<any>(null);
	const [monitor, setMonitor] = useState<any>({});
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
			setPortal(p);
			setMonitor(m);
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
				.then((p) => setPortal(p))
				.catch(console.error);
		}, 60000);
		return () => clearInterval(id);
	}, []);

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
		e.preventDefault();
		try {
			if (editingSource) {
				await updateContextSource(editingSource.url, {
					url: form.url,
					source: form.source,
					context: form.context,
					useTagTemplate: form.useTagTemplate,
					urlTemplate: form.useTagTemplate ? form.url : undefined,
					replaceTagValue: form.replaceTagValue || undefined,
					testTag: form.testTag || undefined,
				});
				setEditingSource(null);
			} else {
				await addContextSource({
					url: form.url,
					source: form.source,
					context: form.context,
					useTagTemplate: form.useTagTemplate,
					urlTemplate: form.useTagTemplate ? form.url : undefined,
					replaceTagValue: form.replaceTagValue || undefined,
					testTag: form.testTag || undefined,
				});
			}
			resetForm();
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed');
		}
	};

	const handleEdit = (src: any) => {
		setEditingSource(src);
		setForm({
			url: src.urlTemplate || src.url || src.homepage || '',
			source: src.source || '',
			context: src.context || 'news',
			useTagTemplate: Boolean(src.type === 'tag-template' || src.urlTemplate),
			replaceTagValue: src.replaceTagValue || '',
			testTag: src.sampleTag || '',
		});
	};

	const handleRemove = async (url: string, isCustom = false) => {
		if (!confirm('Remove this source?')) return;
		try {
			if (isCustom) await removeContextSource(url);
			else await blockContextSource(url);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed');
		}
	};

	const handleUnblock = async (url: string) => {
		try {
			await unblockContextSource(url);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed');
		}
	};

	const handleAddTag = async (tag: string) => {
		if (!tag) return;
		try {
			await addContextTags([tag]);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed');
		}
	};

	const handleRemoveTag = async (tag: string) => {
		try {
			await removeContextTags([tag]);
			await load(true);
		} catch (err: any) {
			alert(err.message || 'Failed');
		}
	};

	if (loading || !portal) return <div className='portal-loading'>Loading SSE Dashboard...</div>;

	const userAdded = Array.isArray(portal.sources.userAdded) ? portal.sources.userAdded : [];
	const blocked = Array.isArray(portal.sources.blocked) ? portal.sources.blocked : [];
	const builtin = Array.isArray(portal.sources.builtin) ? portal.sources.builtin : [];

	return (
		<div className='portal-shell'>
			<header className='portal-header'>
				<h1>SSE Dashboard</h1>
				<div style={{ display: 'flex', gap: 8 }}>
					<button
						className='btn btn-primary'
						onClick={() => load(true)}
						disabled={refreshing}>
						{refreshing ? 'Refreshing...' : 'Refresh'}
					</button>
				</div>
			</header>

			<div className='portal-grid'>
				<div className='portal-column'>
					<section className='panel portal-card'>
						<h3>Status & Config</h3>
						<div>Started: {portal.status.started ? 'yes' : 'no'}</div>
						<div>Stream version: {portal.status.streamVersion}</div>
						<div>Feeds: {portal.status.feedCount}</div>
						<pre style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(portal.config, null, 2)}</pre>
					</section>

					<section className='panel portal-card'>
						<h3>Add / Edit Source</h3>
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
							<div className='form-field'>
								<label>Context</label>
								<select
									value={form.context}
									onChange={(e) => setForm((s) => ({ ...s, context: e.target.value }))}>
									<option value='news'>news</option>
									<option value='research'>research</option>
								</select>
							</div>
							<div className='form-field full-width'>
								<label>
									<input
										type='checkbox'
										checked={form.useTagTemplate}
										onChange={(e) => setForm((s) => ({ ...s, useTagTemplate: e.target.checked }))}
									/>{' '}
									Use as tag template
								</label>
							</div>
							{form.useTagTemplate && (
								<div className='form-field full-width'>
									<label>Replace tag value</label>
									<input
										value={form.replaceTagValue}
										onChange={(e) => setForm((s) => ({ ...s, replaceTagValue: e.target.value }))}
									/>
								</div>
							)}
							{form.useTagTemplate && (
								<div className='form-field full-width'>
									<label>Test tag</label>
									<input
										value={form.testTag}
										onChange={(e) => setForm((s) => ({ ...s, testTag: e.target.value }))}
									/>
								</div>
							)}
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
				</div>

				<div className='portal-column'>
					<section className='panel portal-card portal-sources'>
						<h3>User Sources</h3>
						<div className='portal-list'>
							{userAdded.map((s: any) => (
								<div
									key={s.url}
									className='portal-list-item'>
									<div className='portal-item-main'>
										<div className='portal-item-title'>{s.source}</div>
										<div className='portal-item-url'>{s.url}</div>
									</div>
									<div className='portal-item-actions'>
										<button
											className='btn btn-secondary'
											onClick={() => handleEdit(s)}>
											Edit
										</button>
										<button
											className='btn btn-remove'
											onClick={() => handleRemove(s.url, true)}>
											Remove
										</button>
									</div>
								</div>
							))}
						</div>
					</section>

					<section className='panel portal-card portal-sources'>
						<h3>Blocked Sources</h3>
						<div className='portal-list'>
							{blocked.map((u: string) => (
								<div
									key={u}
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
					</section>
				</div>

				<div className='portal-column'>
					<section className='panel portal-card portal-sources'>
						<h3>Builtin Catalog (sample)</h3>
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

					<section className='panel portal-card'>
						<h3>Live matches (sample)</h3>
						<div className='portal-live-feed-list'>
							{(Array.isArray(portal.output?.matches) ? portal.output.matches : []).slice(0, 30).map((item: any, i: number) => (
								<FeedCard
									key={`${item.id || item.link || item.title || ''}-${i}`}
									item={item}
									className='context-feed-stream-item'
									timestamp={item.publishedAt || item.discoveredAt}
									summaryClassName='context-feed-summary'
									timestampClassName='context-notification-item-meta'
								/>
							))}
						</div>
					</section>
				</div>
			</div>
		</div>
	);
}
