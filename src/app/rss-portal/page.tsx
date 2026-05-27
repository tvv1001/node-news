'use client';

import { useEffect, useState } from 'react';
import { fetchContextPortal, openContextMonitorStream } from '../../api';
import '../../style.css';

function StatusCard({ status }: any) {
	return (
		<div className='panel portal-card'>
			<div className='portal-card-header'>
				<h3>Status</h3>
				<span className={`status-pill ${status.started ? 'status-online' : 'status-offline'}`}>{status.started ? 'Monitoring' : 'Stopped'}</span>
			</div>
			<div className='portal-grid'>
				<div className='portal-stat'>
					<label>Feeds</label>
					<span>{status.feedCount}</span>
				</div>
				<div className='portal-stat'>
					<label>Stream Version</label>
					<span>{status.streamVersion}</span>
				</div>
				<div className='portal-stat'>
					<label>Last Updated</label>
					<span>{status.lastUpdatedAt ? new Date(status.lastUpdatedAt).toLocaleString() : 'Never'}</span>
				</div>
				<div className='portal-stat portal-stat-full'>
					<label>Master RSS Feed (Consolidated Results)</label>
					<code className='portal-url-code'>http://localhost:3001/api/context/rss</code>
				</div>
				{status.lastError && (
					<div className='portal-stat portal-stat-error'>
						<label>Last Error</label>
						<span>{status.lastError}</span>
					</div>
				)}
			</div>
		</div>
	);
}

function ConfigCard({ config }: any) {
	return (
		<div className='panel portal-card'>
			<div className='portal-card-header'>
				<h3>Configuration</h3>
			</div>
			<div className='portal-grid'>
				<div className='portal-stat'>
					<label>Refresh Interval</label>
					<span>{config.refreshMs / 1000}s</span>
				</div>
				<div className='portal-stat'>
					<label>Items Per Source</label>
					<span>{config.itemsPerSource}</span>
				</div>
				<div className='portal-stat'>
					<label>Match Limit</label>
					<span>{config.matchLimit}</span>
				</div>
				<div className='portal-stat'>
					<label>News Source Limit</label>
					<span>{config.generalNewsSourceLimit}</span>
				</div>
				<div className='portal-stat'>
					<label>Engines</label>
					<span>{config.searchEngines.join(', ')}</span>
				</div>
			</div>
		</div>
	);
}

function FeedList({ title, feeds }: any) {
	return (
		<div className='panel portal-card'>
			<div className='portal-card-header'>
				<h3>
					{title} ({feeds.length})
				</h3>
			</div>
			<div className='portal-list'>
				{feeds.map((feed: any, index: number) => (
					<div
						key={index}
						className='portal-list-item'>
						<div className='portal-item-main'>
							<div className='portal-item-title'>{feed.source}</div>
							<div className='portal-item-url'>{feed.url}</div>
						</div>
						<div className='portal-item-tags'>
							{feed.tags?.map((tag: string) => (
								<span
									key={tag}
									className='portal-tag-pill'>
									{tag}
								</span>
							))}
						</div>
					</div>
				))}
				{!feeds.length && <div className='portal-empty'>No feeds available.</div>}
			</div>
		</div>
	);
}

function OutputList({ title, items }: any) {
	return (
		<div className='panel portal-card'>
			<div className='portal-card-header'>
				<h3>{title}</h3>
			</div>
			<div className='portal-list'>
				{items.map((item: any, index: number) => (
					<div
						key={index}
						className='portal-list-item'>
						<div className='portal-item-main'>
							<div className='portal-item-title'>{item.title}</div>
							<div className='portal-item-source'>
								{item.source} • {new Date(item.publishedAt || item.discoveredAt).toLocaleString()}
							</div>
						</div>
					</div>
				))}
				{!items.length && <div className='portal-empty'>No recent items.</div>}
			</div>
		</div>
	);
}

export default function RssPortal() {
	const [data, setData] = useState<any>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState('');
	const [isLiveConnected, setIsLiveConnected] = useState(false);

	const loadData = async () => {
		setLoading(true);
		try {
			const portalData = await fetchContextPortal();
			setData(portalData);
			setError('');
		} catch (err: any) {
			setError(err.message || 'Failed to load portal data');
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		loadData();
		const stream = openContextMonitorStream({
			onSnapshot: (payload: any) => {
				if (!payload || !payload.snapshot) return;
				setData(payload.snapshot);
				setError('');
			},
			onOpen: () => setIsLiveConnected(true),
			onError: () => setIsLiveConnected(false),
		});

		return () => {
			if (stream && typeof stream.close === 'function') {
				stream.close();
			}
		};
	}, []);

	if (loading && !data) {
		return (
			<div className='dark-route-shell portal-dark-shell portal-shell'>
				<div className='portal-loading'>Loading RSS Portal...</div>
			</div>
		);
	}

	if (error && !data) {
		return (
			<div className='dark-route-shell portal-dark-shell portal-shell'>
				<div className='portal-error'>Error: {error}</div>
			</div>
		);
	}

	return (
		<div className='dark-route-shell portal-dark-shell portal-shell'>
			<header className='portal-header'>
				<h1>RSS Builder Management Portal</h1>
				<div>
					<button
						className='btn'
						onClick={loadData}>
						Refresh Now
					</button>
					<span className={`status-pill ${isLiveConnected ? 'status-online' : 'status-offline'}`}>{isLiveConnected ? 'SSE Connected' : 'SSE Disconnected'}</span>
				</div>
			</header>

			<div className='portal-layout'>
				<div className='portal-column'>
					<StatusCard status={data.status} />
					<ConfigCard config={data.config} />
					<div className='panel portal-card'>
						<div className='portal-card-header'>
							<h3>Active Tags</h3>
						</div>
						<div className='portal-tags-list'>
							{data.tags.map((tag: string) => (
								<span
									key={tag}
									className='portal-tag-pill is-active'>
									{tag}
								</span>
							))}
							{!data.tags.length && <span>No active tags.</span>}
						</div>
					</div>
				</div>

				<div className='portal-column portal-column-wide'>
					<FeedList
						title='Active Catalog (Generated)'
						feeds={data.catalog}
					/>
					<FeedList
						title='Built-in Feeds'
						feeds={data.sources.builtin}
					/>
					<FeedList
						title='General News Catalog'
						feeds={data.sources.generalNewsCatalog}
					/>
					<FeedList
						title='Configured Alerts'
						feeds={data.sources.configuredAlerts}
					/>
				</div>

				<div className='portal-column'>
					<OutputList
						title='Recent Matches'
						items={data.output.matches}
					/>
					<OutputList
						title='Recent General News'
						items={data.output.generalNews}
					/>
				</div>
			</div>
		</div>
	);
}
