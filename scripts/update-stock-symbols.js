import { ensureStockSymbolCatalog, getStockSymbolCatalogSnapshot } from '../server/services/context/stockSymbolRegistry.js';
import { logger } from '../server/utils/logger.js';

const snapshot = await ensureStockSymbolCatalog({ force: true });

if (!snapshot.ready) {
	throw new Error('US stock symbol catalog refresh did not produce a usable symbol set.');
}

logger.info('US stock symbol catalog refreshed', getStockSymbolCatalogSnapshot());
