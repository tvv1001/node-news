import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { searchRouter, startBackgroundCrawlService } from './routes/search.js';
import { texasRouter } from './routes/texas.js';
import { oscnRouter } from './routes/oscn.js';
import { rssRouter } from './routes/rss.js';
import { contextRouter } from './routes/context.js';
import { startContextFeedMonitor } from './services/context/contextFeedService.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { logger } from './utils/logger.js';

const app = express();
const DEFAULT_PORT = 3001;
const rawPort = Number.parseInt(process.env.PORT || `${DEFAULT_PORT}`, 10);
const PORT = Number.isNaN(rawPort) ? DEFAULT_PORT : rawPort;

// Security headers
app.use(helmet());

// CORS — allow the configured frontend origin and local Vite dev ports
const configuredOrigin = process.env.FRONTEND_ORIGIN || 'http://localhost:5173';

app.use(
	cors({
		origin(origin, callback) {
			if (!origin) return callback(null, true);

			const isLocalDevOrigin = /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);

			if (origin === configuredOrigin || isLocalDevOrigin || origin === 'http://localhost:3000') {
				return callback(null, true);
			}

			return callback(new Error('Not allowed by CORS'));
		},
		methods: ['GET', 'POST', 'PUT', 'DELETE'],
		allowedHeaders: ['Content-Type', 'Authorization'],
	}),
);

// Body parsing
app.use(express.json({ limit: '2mb' }));

// Apply rate limiting to all API routes
app.use('/api/', apiLimiter);

// Routes
app.use('/api/search', searchRouter);
app.use('/api/texas', texasRouter);
app.use('/api/oscn', oscnRouter);
app.use('/api/rss', rssRouter);
// X/Twitter scraper routes removed per user request (references to x.com/twitter disabled)
app.use('/api/context', contextRouter);

// Health check
app.get('/health', (_req, res) => {
	res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 404 handler
app.use((_req, res) => {
	res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
	logger.error('API error', { error: err.message, stack: err.stack });

	// If it's a validation error or similar known error, send the message.
	// Otherwise send a generic one.
	const statusCode = err.status || 500;
	res.status(statusCode).json({
		error: err.message || 'Internal server error',
	});
});

function startServer(port, retriesLeft = 10) {
	const server = app.listen(port, () => {
		logger.info(`Query Notify API running on port ${port}`);
		startBackgroundCrawlService();
		startContextFeedMonitor();
	});

	server.on('error', (err) => {
		if (err?.code === 'EADDRINUSE' && retriesLeft > 0) {
			const nextPort = port + 1;
			logger.warn(`Port ${port} is in use. Retrying on port ${nextPort} (${retriesLeft} retries left).`);
			startServer(nextPort, retriesLeft - 1);
			return;
		}

		logger.error('Failed to start server', {
			error: err?.message,
			code: err?.code,
			stack: err?.stack,
		});
		process.exit(1);
	});
}

startServer(PORT);
