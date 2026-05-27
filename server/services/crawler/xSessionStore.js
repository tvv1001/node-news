function normalizeValue(value = '') {
	return String(value || '').trim();
}

export function getActiveXCredentials() {
	const authToken = normalizeValue(process.env.X_AUTH_TOKEN);
	const csrfToken = normalizeValue(process.env.X_CSRF_TOKEN);

	if (!authToken || !csrfToken) return null;

	return {
		authToken,
		csrfToken,
	};
}

export function hasActiveXCredentials() {
	return Boolean(getActiveXCredentials());
}
