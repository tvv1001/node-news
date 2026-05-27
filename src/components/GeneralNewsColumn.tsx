import { useEffect, useMemo, useRef, useState } from 'react';
import FeedCard from './FeedCard';

function formatMonitorTimestamp(value = '') {
	if (!value) return 'Refreshing';
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return 'Refreshing';
	return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

function GeneralNewsColumn({ monitor = {} as any }: any) {
	const [isPaused, setIsPaused] = useState(false);
	const scrollRef = useRef(null);
	const items = useMemo(() => (Array.isArray(monitor.generalNews) ? monitor.generalNews : []), [monitor.generalNews]);
	const progressiveFeedState = monitor.progressiveFeedState || {};
	const isLoadingMore = Boolean(progressiveFeedState.active) && (progressiveFeedState.generalNewsLoadedCount || 0) < (progressiveFeedState.generalNewsTotal || 0);

	useEffect(() => {
		const node = scrollRef.current;
		if (!node) return undefined;

		const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
		node.scrollTop = Math.min(node.scrollTop, maxScroll);
		if (isPaused) return undefined;

		let frameId = 0;
		let lastTime = performance.now();

		const tick = (time) => {
			const maxScroll = node.scrollHeight - node.clientHeight;
			const deltaMultiplier = Math.min((time - lastTime) / 16, 4);
			lastTime = time;

			if (maxScroll > 4) {
				node.scrollTop += 0.22 * deltaMultiplier;
				if (node.scrollTop >= maxScroll - 1) {
					node.scrollTop = 0;
				}
			}

			frameId = window.requestAnimationFrame(tick);
		};

		frameId = window.requestAnimationFrame(tick);
		return () => window.cancelAnimationFrame(frameId);
	}, [items, isPaused]);

	return (
		<aside className='general-news-column panel'>
			<h3>All News</h3>
			{monitor.generalNewsLastError && <p className='context-empty-copy'>News lane warning: {monitor.generalNewsLastError}</p>}

			<div className='context-ticker-card context-column-card context-column-card-fill'>
				<div className='context-ticker-header'></div>
				<div
					ref={scrollRef}
					className='context-ticker-window context-feed-window general-news-window'
					onMouseEnter={() => setIsPaused(true)}
					onMouseLeave={() => setIsPaused(false)}>
					<div className='context-ticker-track'>
						{items.map((item, index) => (
							<FeedCard
								key={`${item.id || item.link || item.title || 'general-news-item'}:${index}`}
								item={item}
								className='general-news-item'
								timestamp={formatArticleTimestamp(item.publishedAt, item.discoveredAt)}
							/>
						))}
						{!items.length && (
							<span className='context-empty-copy'>The latest all-news headlines from curated and live sources will roll through here once the feeds refresh.</span>
						)}
						{isLoadingMore && items.length > 0 && <span className='context-feed-loading-copy'>Loading more headlines in the background…</span>}
					</div>
				</div>
			</div>
		</aside>
	);
}

export default GeneralNewsColumn;
