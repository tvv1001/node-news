export default class getTopNews {
	async getStories(limit = 30) {
		const ids = await (await fetch('https://hacker-news.firebaseio.com/v0/topstories.json')).json();
		const slice = Array.isArray(ids) ? ids.slice(0, limit) : [];
		const data = await Promise.all(
			slice.map(async (i: number) => {
				try {
					const item = await (await fetch(`https://hacker-news.firebaseio.com/v0/item/${i}.json?print=pretty`)).json();
					return item;
				} catch (err) {
					return null;
				}
			}),
		);
		return data.filter(Boolean);
	}
}
