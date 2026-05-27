import { memo, useMemo, useState, useRef, useEffect } from 'react';
import { extractLinkifiedFeedTokens, getFeedSourceHref } from './feedCardUtils';

const COLLAPSED_CARD_HEIGHT = 500;
const AUTO_EXPAND_LINE_COUNT = 3;

type FeedCardProps = {
	item?: any;
	className?: string;
	timestamp?: string;
	summaryClassName?: string;
	titleClassName?: string;
	sourceClassName?: string;
	timestampClassName?: string;
	allowDetailedContent?: boolean;
};

function unescapeHtml(text = '') {
	return String(text || '')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'");
}

const IMAGE_SRC_RE = /^data:image\/|^https?:\/\/.*\.(?:avif|apng|bmp|gif|jpe?g|jfif|pjpeg|png|svg|webp)(?:[?#].*)?$/i;
const VIDEO_SRC_RE = /^https?:\/\/.*\.(?:mp4|mov|webm|ogg|mpg|mpeg|m4v)(?:[?#].*)?$/i;
const REDDIT_HOST_RE = /(^|\.)reddit\.com$/i;
const REDDIT_SHORT_RE = /^redd\.it$/i;

function isImageUrl(value = '') {
	return IMAGE_SRC_RE.test(String(value || '').trim());
}

function isDirectVideoUrl(value = '') {
	return VIDEO_SRC_RE.test(String(value || '').trim()) || /^https?:\/\/v\.redd\.it\//i.test(String(value || '').trim());
}

function getRedditThreadId(value = '') {
	try {
		const url = new URL(String(value || '').trim());
		const hostname = url.hostname.toLowerCase().replace(/^www\./, '');
		if (REDDIT_SHORT_RE.test(hostname)) {
			const id = url.pathname.split('/').filter(Boolean)[0];
			return id || '';
		}
		if (REDDIT_HOST_RE.test(hostname)) {
			const match = url.pathname.match(/\/comments\/([a-z0-9]+)(?:\/|$)/i);
			return match?.[1] || '';
		}
	} catch {
		return '';
	}
	return '';
}

function buildRedditEmbedUrl(value = '') {
	const threadId = getRedditThreadId(value);
	if (!threadId) return '';
	return `https://www.redditmedia.com/comments/${threadId}?ref_source=embed&ref=share&embed=true`;
}

function getPreviewMediaMode(item: any = {}) {
	const rawSrc = String(item?.previewImage?.src || '').trim();
	if (!rawSrc) return { type: 'none', src: '' };

	if (isImageUrl(rawSrc)) {
		return { type: 'image', src: rawSrc };
	}

	if (isDirectVideoUrl(rawSrc)) {
		return { type: 'video', src: rawSrc };
	}

	const redditEmbedUrl = buildRedditEmbedUrl(item.link || rawSrc);
	if (redditEmbedUrl) {
		return { type: 'reddit-embed', src: redditEmbedUrl };
	}

	return { type: 'unknown', src: rawSrc };
}

function FeedCard({
	item = {},
	className = '',
	timestamp = '',
	summaryClassName = 'context-feed-summary',
	titleClassName = 'context-ticker-title',
	sourceClassName = 'context-ticker-source',
	timestampClassName = 'context-notification-item-meta',
	allowDetailedContent = false,
}: FeedCardProps) {
	const [hidePreviewImage, setHidePreviewImage] = useState(false);
	const [isExpanded, setIsExpanded] = useState(false);
	const [isPreviewExpanded, setIsPreviewExpanded] = useState(false);
	const [needsExpansion, setNeedsExpansion] = useState(false);
	const [shouldAutoExpand, setShouldAutoExpand] = useState(false);
	const contentRef = useRef<HTMLDivElement>(null);

	const previewImage = !hidePreviewImage && item?.previewImage?.src ? item.previewImage : null;
	const previewMedia = useMemo(() => getPreviewMediaMode(item), [item]);
	const isImagePreview = previewMedia.type === 'image';
	const previewMediaUrl = previewMedia.type === 'video' || previewMedia.type === 'reddit-embed' ? previewMedia.src : '';
	const imageSrc = useMemo(() => (isImagePreview && previewImage?.src ? unescapeHtml(previewImage.src) : ''), [isImagePreview, previewImage?.src]);
	const sourceHref = getFeedSourceHref(item);
	const summaryText = String(item?.summary || '').trim();
	const isFullStoryInComments = /\bfull story\b.*\bcomments?\b/i.test(summaryText);
	const detailedTextCandidate = String(item?.contentSnippet || item?.content || '').trim();
	const storyUrl = String(item?.originalLink || item?.link || item?.commentsLink || '').trim();
	const detailedText =
		detailedTextCandidate && !/\bfull story\b.*\bcomments?\b/i.test(detailedTextCandidate) && detailedTextCandidate !== summaryText ? detailedTextCandidate
		: storyUrl ? `Story link: ${storyUrl}`
		: '';
	const displaySummaryText = allowDetailedContent && isFullStoryInComments && detailedText ? detailedText : summaryText;
	const summaryTokens = useMemo(() => extractLinkifiedFeedTokens(displaySummaryText, item), [displaySummaryText, item]);

	useEffect(() => {
		const node = contentRef.current;
		if (!node) return undefined;

		const updateExpansionNeed = () => {
			const hiddenHeight = Math.max(0, node.scrollHeight - COLLAPSED_CARD_HEIGHT);
			const computedStyles = window.getComputedStyle(node);
			const parsedLineHeight = Number.parseFloat(computedStyles.lineHeight || '');
			const fallbackFontSize = Number.parseFloat(computedStyles.fontSize || '16');
			const lineHeight = Number.isFinite(parsedLineHeight) ? parsedLineHeight : fallbackFontSize * 1.5;
			const autoExpandThreshold = Math.max(lineHeight * AUTO_EXPAND_LINE_COUNT, 48);
			const nextShouldAutoExpand = hiddenHeight > 0 && hiddenHeight <= autoExpandThreshold;

			setShouldAutoExpand(nextShouldAutoExpand);
			setNeedsExpansion(hiddenHeight > autoExpandThreshold);
		};

		updateExpansionNeed();

		if (typeof ResizeObserver === 'undefined') {
			return undefined;
		}

		const resizeObserver = new ResizeObserver(() => {
			updateExpansionNeed();
		});

		resizeObserver.observe(node);

		return () => {
			resizeObserver.disconnect();
		};
	}, [item, previewImage?.src, summaryTokens.length]);

	const isCardExpanded = isExpanded || shouldAutoExpand;
	const canToggleFromSummary = needsExpansion;

	const handleSummaryToggle = (event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>) => {
		const target = event.target as HTMLElement | null;
		if (target?.closest('a, button, img')) {
			return;
		}

		if (!canToggleFromSummary) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		setIsExpanded((current) => !current);
	};

	return (
		<article
			className={[
				'context-ticker-item',
				className,
				isCardExpanded ? 'is-card-expanded' : 'is-card-collapsed',
				needsExpansion ? 'has-card-overflow' : '',
				shouldAutoExpand ? 'is-card-auto-expanded' : '',
			]
				.filter(Boolean)
				.join(' ')}>
			<div
				className='context-feed-content'
				ref={contentRef}>
				<div className='context-feed-meta-row'>
					{sourceHref ?
						<a
							className={`${sourceClassName} context-feed-source-link`}
							href={sourceHref}
							target='_blank'
							rel='noopener noreferrer'>
							{item.source}
						</a>
					:	<span className={sourceClassName}>{item.source}</span>}
					{item.author && <span className={`${sourceClassName} context-feed-author`}>{item.author}</span>}
					<span
						className={timestampClassName}
						title={item.publishedAt || item.discoveredAt || ''}>
						{timestamp}
					</span>
				</div>
				{item.link ?
					<a
						className={`${titleClassName} context-feed-title-link`}
						href={item.link}
						target='_blank'
						rel='noopener noreferrer'>
						{item.title}
					</a>
				:	<span className={titleClassName}>{item.title}</span>}
				{previewImage && (imageSrc || previewMediaUrl) && (
					<div className={`context-feed-preview ${isPreviewExpanded ? 'is-expanded' : 'is-collapsed'}`}>
						{isImagePreview ?
							<>
								<button
									type='button'
									className='context-feed-preview-toggle'
									onClick={(event) => {
										event.preventDefault();
										event.stopPropagation();
										setIsPreviewExpanded((current) => !current);
									}}
									aria-expanded={isPreviewExpanded}
									aria-label={isPreviewExpanded ? 'Collapse image preview' : 'Expand image preview'}>
									<img
										src={imageSrc}
										alt={previewImage.alt || item.title || 'Article image'}
										loading='lazy'
										onError={() => setHidePreviewImage(true)}
									/>
									<span className='context-feed-preview-toggle-label'>{isPreviewExpanded ? 'Collapse image' : 'Expand image'}</span>
								</button>
								{isPreviewExpanded && (
									<button
										type='button'
										className='context-feed-preview-close'
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											setIsPreviewExpanded(false);
										}}>
										Close image
									</button>
								)}
							</>
						:	<div className='context-feed-preview-media'>
								{previewMedia.type === 'video' ?
									<video
										controls
										playsInline
										muted
										preload='metadata'
										src={previewMediaUrl}
										aria-label={previewImage.alt || item.title || 'Embedded video'}
									/>
								:	<iframe
										loading='lazy'
										title={previewImage.alt || item.title || 'Embedded video'}
										src={previewMediaUrl}
										sandbox='allow-scripts allow-same-origin allow-popups allow-forms'
									/>
								}
							</div>
						}
					</div>
				)}
				{displaySummaryText && (
					<div
						className={`context-feed-summary-wrapper ${canToggleFromSummary ? 'is-expandable' : ''}`}
						onClick={handleSummaryToggle}
						onKeyDown={(event) => {
							if (event.key === 'Enter' || event.key === ' ') {
								handleSummaryToggle(event);
							}
						}}
						role={canToggleFromSummary ? 'button' : undefined}
						tabIndex={canToggleFromSummary ? 0 : undefined}
						aria-expanded={canToggleFromSummary ? isCardExpanded : undefined}
						aria-label={
							canToggleFromSummary ?
								isCardExpanded ?
									'Collapse full summary text'
								:	'Expand full summary text'
							:	undefined
						}>
						<span className={summaryClassName}>
							{summaryTokens.map((token, index) =>
								token.type === 'link' ?
									<a
										key={`${token.value}-${index}`}
										className='context-feed-inline-link'
										href={token.href}
										target='_blank'
										rel='noopener noreferrer'>
										{token.value}
									</a>
								:	<span key={`${token.value}-${index}`}>{token.value}</span>,
							)}
						</span>
						{canToggleFromSummary && !isCardExpanded && <span className='context-feed-expand-hint'>Tap text to expand</span>}
					</div>
				)}
			</div>
			{(needsExpansion || isExpanded) && (
				<div className={`card-reveal-footer ${!isCardExpanded && needsExpansion ? 'is-overlay' : ''}`}>
					<button
						type='button'
						className='card-reveal-link'
						onClick={(e) => {
							e.preventDefault();
							e.stopPropagation();
							setIsExpanded(!isExpanded);
						}}>
						{isExpanded ? 'Show less' : 'Read more'}
					</button>
				</div>
			)}
		</article>
	);
}

export default memo(FeedCard, (previousProps, nextProps) => {
	return (
		previousProps.item === nextProps.item &&
		previousProps.className === nextProps.className &&
		previousProps.timestamp === nextProps.timestamp &&
		previousProps.summaryClassName === nextProps.summaryClassName &&
		previousProps.titleClassName === nextProps.titleClassName &&
		previousProps.sourceClassName === nextProps.sourceClassName &&
		previousProps.timestampClassName === nextProps.timestampClassName
	);
});
