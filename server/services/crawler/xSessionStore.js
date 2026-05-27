/**
 * Minimal xSessionStore shim to provide active X credentials if present.
 */

export function getActiveXCredentials() {
	if (process.env.X_AUTH_TOKEN && process.env.X_CSRF_TOKEN) {
		return { authToken: process.env.X_AUTH_TOKEN, csrfToken: process.env.X_CSRF_TOKEN };
	}
	return null;
}

export default { getActiveXCredentials };
