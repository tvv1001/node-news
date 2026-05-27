import { useEffect, useRef } from 'react';

function ContextSidebar({ monitor = {} as any, onEnableNotifications, onClearNotifications, onDismissNotification }: any) {
	const shownNotificationIds = useRef(new Set());
	const notifications = Array.isArray(monitor.notifications) ? monitor.notifications : [];
	const recentMatches = Array.isArray(monitor.matches) ? monitor.matches : [];
	const displayItems = notifications.length ? notifications.slice(0, 6) : recentMatches.slice(0, 6);
	const isShowingRecentMatches = !notifications.length && displayItems.length > 0;

	useEffect(() => {
		if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
		for (const item of notifications) {
			if (!item?.id || shownNotificationIds.current.has(item.id)) continue;
			shownNotificationIds.current.add(item.id);
			const body = [item.source, item.matchedKeywords?.length ? `Matched: ${item.matchedKeywords.join(', ')}` : 'Keyword alert'].filter(Boolean).join(' • ');
			const notification = new Notification(item.title || 'Context alert', { body });
			if (item.link) {
				notification.onclick = () => window.open(item.link, '_blank', 'noopener,noreferrer');
			}
		}
	}, [notifications]);

	return (
		<aside className='context-sidebar context-sidebar-tags panel'>
			{monitor.lastError && <p className='context-empty-copy'>Feed warning: {monitor.lastError}</p>}

			<div className='context-notifications-card context-column-card context-column-card-fill'>
				<div className='context-ticker-header'>
					<h3>Notifications</h3>
					<div className='context-notification-actions'>
						<button
							type='button'
							className='btn btn-secondary context-notification-button'
							onClick={onEnableNotifications}>
							Enable alerts
						</button>
						<button
							type='button'
							className='btn btn-secondary context-notification-button'
							onClick={onClearNotifications}
							disabled={!notifications.length}>
							Clear
						</button>
					</div>
				</div>
				<div className='context-notification-list context-notification-list-compact'>
					{displayItems.map((item) => (
						<div
							key={item.id}
							className='context-notification-item context-notification-card'>
							{!isShowingRecentMatches && (
								<button
									type='button'
									className='context-notification-dismiss'
									onClick={() => onDismissNotification?.(item.id)}
									aria-label={`Remove alert ${item.title || item.id}`}>
									×
								</button>
							)}
							<a
								className='context-notification-link'
								href={item.link || '#'}
								target='_blank'
								rel='noreferrer'>
								<span className='context-notification-context'>{isShowingRecentMatches ? 'Tag match' : item.context}</span>
								<strong>{item.title}</strong>
								<span>{item.source}</span>
								{isShowingRecentMatches && item.matchedKeywords?.length > 0 && <span>Matched: {item.matchedKeywords.join(', ')}</span>}
							</a>
						</div>
					))}
					{!displayItems.length && <span className='context-empty-copy'>Notifications will appear here when new feed items match your tags.</span>}
					{isShowingRecentMatches && <span className='context-empty-copy'>Alerts are cleared, but the latest tag-matched content stays visible here for quick scanning.</span>}
				</div>
			</div>
		</aside>
	);
}

export default ContextSidebar;
