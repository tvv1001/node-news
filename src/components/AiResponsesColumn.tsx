function formatSourceLabel(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return 'Web';
	return normalized
		.split(',')
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' · ');
}

function toParagraphs(value = '') {
	return String(value || '')
		.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z])/)
		.map((part) => part.trim())
		.filter(Boolean)
		.slice(0, 4);
}

function formatResultType(value = '') {
	const normalized = String(value || '').trim();
	if (!normalized) return 'AI';

	return normalized
		.split('-')
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(' ');
}

function isWikipediaResult(result: any = {}) {
	const url = String(result?.url || '').toLowerCase();
	const domain = String(result?.domain || '').toLowerCase();
	const source = String(result?.source || result?.sourceLabel || '').toLowerCase();
	const title = String(result?.title || '').toLowerCase();

	return url.includes('wikipedia.org/') || domain.includes('wikipedia.org') || source.includes('wikipedia') || title.includes(' - wikipedia');
}

function normalizeWikipediaCopy(value = '') {
	return String(value || '')
		.replace(/^from wikipedia, the free encyclopedia\s*/i, '')
		.replace(/\s*IMPORTANT NOTE:.*$/is, '')
		.trim();
}

function renderCompactSectionHeader(title, count) {
	return (
		<div className='results-section-header'>
			<div>
				<h2>{title}</h2>
			</div>
			<span className='results-count'>{count}</span>
		</div>
	);
}

function AiResponsesColumn({
	results,
	aiResponses,
	loading,
	error,
	searchTerm,
	title = 'AI responses',
	description = 'Model summaries and cited source links stay in their own lane for faster scanning.',
	emptyTitle = 'No AI responses yet',
	emptyDescription,
}) {
	const safeResults = Array.isArray(results) ? results : [];
	const normalizedAiResponses =
		Array.isArray(aiResponses) && aiResponses.length ?
			aiResponses
		:	safeResults.filter((result) => ['ai-answer', 'ai-supporting-article', 'ai-citation'].includes(String(result?.resultType || '').toLowerCase()));
	const googleAiResponses = normalizedAiResponses.filter((result) => String(result?.source || '').toLowerCase() === 'google');
	const bingAiResponses = normalizedAiResponses.filter((result) => String(result?.source || '').toLowerCase() === 'bing');
	const otherAiResponses = normalizedAiResponses.filter((result) => !['google', 'bing'].includes(String(result?.source || '').toLowerCase()));
	const wikipediaResponse = safeResults.find((result) => result?.resultType !== 'ai-answer' && isWikipediaResult(result));
	const wikipediaParagraphs = toParagraphs(normalizeWikipediaCopy(wikipediaResponse?.content || wikipediaResponse?.snippet || ''));
	const effectiveEmptyDescription =
		emptyDescription ||
		(searchTerm ? `The crawl for “${searchTerm}” completed without a separate AI summary yet.` : 'Run or auto-seed a crawl to populate the model response lane.');

	const renderAiResponseCard = (result, index) => (
		<article
			key={`${result.source || 'ai'}-${result.resultType || 'response'}-${index}`}
			className='ai-response-card'>
			<div className='ai-response-card-header'>
				<div>
					<p className='results-kicker'>{formatSourceLabel(result.source)}</p>
					<h3>{result.title || `${formatSourceLabel(result.source)} ${formatResultType(result.resultType).toLowerCase()}`}</h3>
				</div>
				<span className='result-pill result-pill-ai'>{formatResultType(result.resultType)}</span>
			</div>
			<div className='ai-response-copy'>
				{toParagraphs(result.snippet).map((paragraph, paragraphIndex) => (
					<p key={paragraphIndex}>{paragraph}</p>
				))}
			</div>
			{Array.isArray(result.references) && result.references.length > 0 && (
				<div className='ai-response-references'>
					<h4>Referenced sources</h4>
					<ul>
						{result.references.map((reference, referenceIndex) => (
							<li key={`${reference.url || reference.title || 'reference'}-${referenceIndex}`}>
								<a
									href={reference.url}
									target='_blank'
									rel='noopener noreferrer'>
									{reference.title || reference.url}
								</a>
							</li>
						))}
					</ul>
				</div>
			)}
		</article>
	);

	const renderAiResponseGroup = (heading, items, keyPrefix) => {
		if (!items.length) return null;

		return (
			<section className='ai-response-source-group'>
				<h3>{heading}</h3>
				{items.map((result, index) => renderAiResponseCard(result, `${keyPrefix}-${index}`))}
			</section>
		);
	};

	if (loading) {
		return (
			<div className='results-shell'>
				<section className='results-section ai-column-section'>
					{renderCompactSectionHeader(title, '…')}
					<section className='results-state-card'>
						<div className='results-state-icon'>🤖</div>
						<div>
							<h3>Waiting for model output</h3>
							<p>AI summaries will land here as the crawl finishes collecting and ranking sources.</p>
						</div>
					</section>
				</section>
			</div>
		);
	}

	if (error && !normalizedAiResponses.length) {
		return (
			<div className='results-shell'>
				<section className='results-section ai-column-section'>
					{renderCompactSectionHeader(title, 0)}
					<section className='results-state-card results-state-card-error'>
						<div className='results-state-icon'>⚠</div>
						<div>
							<h3>AI responses unavailable</h3>
							<p>{error}</p>
						</div>
					</section>
				</section>
			</div>
		);
	}

	return (
		<div className='results-shell'>
			<section className='results-section ai-column-section'>
				{renderCompactSectionHeader(title, normalizedAiResponses.length)}

				{normalizedAiResponses.length || wikipediaResponse ?
					<div className='ai-section-grid ai-section-grid-single-column'>
						{renderAiResponseGroup('Google AI responses', googleAiResponses, 'google-ai')}
						{renderAiResponseGroup('Bing AI responses', bingAiResponses, 'bing-ai')}
						{renderAiResponseGroup('Other AI responses', otherAiResponses, 'other-ai')}

						{wikipediaResponse && (
							<article className='ai-response-card wikipedia-response-card'>
								<div className='ai-response-card-header'>
									<div>
										<p className='results-kicker'>Wikipedia response</p>
										<h3>{wikipediaResponse.title || 'Wikipedia article'}</h3>
									</div>
									<span className='result-pill wikipedia-response-pill'>Wikipedia</span>
								</div>
								<div className='ai-response-copy'>
									{wikipediaParagraphs.length ?
										wikipediaParagraphs.map((paragraph, paragraphIndex) => <p key={paragraphIndex}>{paragraph}</p>)
									:	<p>{wikipediaResponse.snippet || 'Open the Wikipedia article for more background and supporting references.'}</p>}
								</div>
								<div className='ai-response-references'>
									<h4>Wikipedia article</h4>
									<ul>
										<li>
											<a
												href={wikipediaResponse.url}
												target='_blank'
												rel='noopener noreferrer'>
												{wikipediaResponse.url}
											</a>
										</li>
									</ul>
								</div>
							</article>
						)}
					</div>
				:	<section className='results-state-card'>
						<div className='results-state-icon'>🧠</div>
						<div>
							<h3>{emptyTitle}</h3>
							<p>{effectiveEmptyDescription}</p>
						</div>
					</section>
				}
			</section>
		</div>
	);
}

export default AiResponsesColumn;
