import { useEffect, useState } from 'react';

export const DEFAULT_SEARCH_TERM = 'quantum lattice holographic';

function SearchForm({
	onSearch,
	loading,
	defaultSearchValue = DEFAULT_SEARCH_TERM,
	title = 'Slow crawler',
	description = 'Seed a slower crawl that scans sites and supporting documents for the current topic.',
	label = 'Crawler query',
	placeholder = 'Enter a tag or operator-rich query, e.g. site:gov "land records" after:2025-01-01',
	submitLabel = 'Start crawl',
	resetLabel = 'Reset query',
}: any) {
	const normalizedDefaultSearchValue = String(defaultSearchValue || '').trim() || DEFAULT_SEARCH_TERM;
	const [searchValue, setSearchValue] = useState(normalizedDefaultSearchValue);

	useEffect(() => {
		setSearchValue(normalizedDefaultSearchValue);
	}, [normalizedDefaultSearchValue]);

	const handleSubmit = (e: any) => {
		e.preventDefault();
		onSearch(searchValue);
	};

	const handleReset = () => {
		setSearchValue(normalizedDefaultSearchValue);
	};

	return (
		<form
			className='search-form'
			onSubmit={handleSubmit}
			autoComplete='off'>
			<div className='status-meta'>
				<div className='status-meta-activity'>{title}</div>
				<div>{description}</div>
			</div>
			<div className='form-grid'>
				<div className='form-field full-width'>
					<label htmlFor='searchQuery'>{label}</label>
					<input
						type='text'
						id='searchQuery'
						name='searchQuery'
						placeholder={placeholder}
						value={searchValue}
						onChange={(e) => setSearchValue(e.target.value)}
					/>
				</div>
			</div>

			<div className='form-actions'>
				<button
					type='submit'
					className='btn btn-primary'
					disabled={loading}>
					{loading ? '⏳ Crawling…' : `🕷️ ${submitLabel}`}
				</button>
				<button
					type='button'
					className='btn btn-secondary'
					onClick={handleReset}>
					{resetLabel}
				</button>
			</div>
		</form>
	);
}

export default SearchForm;
