// server.js - eBay Finding API Backend for Avasam Price Comparison
// Uses SOLD/COMPLETED listings for accurate market data
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache (24 hour expiry)
const cache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in ms

// Middleware
app.use(cors());
app.use(express.json());

// ============ EBAY FINDING API ============

async function searchEbaySoldItems(query) {
    const appId = process.env.EBAY_CLIENT_ID;

    if (!appId) {
        throw new Error('Missing EBAY_CLIENT_ID environment variable');
    }

    // Check cache first
    const cacheKey = query.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log(`✓ Cache hit for: "${query}"`);
        return { ...cached.data, fromCache: true };
    }

    // Clean up the query
    let cleanQuery = query
        .replace(/[^\w\s\-\.]/g, ' ')  // Remove special chars
        .replace(/\s+/g, ' ')           // Normalize spaces
        .trim()
        .substring(0, 100);             // Limit length

    console.log(`🔍 Searching eBay SOLD listings for: "${cleanQuery}"`);

    try {
        // eBay Finding API - findCompletedItems operation
        // This returns SOLD items only (completed auctions and purchases)
        const response = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
            params: {
                'OPERATION-NAME': 'findCompletedItems',
                'SERVICE-VERSION': '1.13.0',
                'SECURITY-APPNAME': appId,
                'RESPONSE-DATA-FORMAT': 'JSON',
                'REST-PAYLOAD': '',
                'keywords': cleanQuery,
                'categoryId': '',  // All categories
                'itemFilter(0).name': 'SoldItemsOnly',
                'itemFilter(0).value': 'true',
                'itemFilter(1).name': 'Condition',
                'itemFilter(1).value': '1000',  // New items only
                'itemFilter(2).name': 'LocatedIn',
                'itemFilter(2).value': 'GB',    // UK only
                'sortOrder': 'EndTimeSoonest',
                'paginationInput.entriesPerPage': '100',  // Get 100 results for better average
                'GLOBAL-ID': 'EBAY-GB'
            }
        });

        const searchResult = response.data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
        const items = searchResult?.item || [];
        const totalResults = parseInt(searchResult?.['@count'] || '0');

        console.log(`Found ${items.length} sold items (total: ${totalResults})`);

        if (items.length === 0) {
            console.log('No sold items found');
            return null;
        }

        // Extract prices from sold items
        const prices = items
            .map(item => {
                // Get the selling price (what it actually sold for)
                const priceData = item.sellingStatus?.[0]?.currentPrice?.[0];
                if (priceData && priceData['@currencyId'] === 'GBP') {
                    return parseFloat(priceData['__value__']);
                }
                return null;
            })
            .filter(p => p !== null && p > 0 && p < 10000);

        if (prices.length === 0) {
            console.log('No valid GBP prices found');
            return null;
        }

        // Calculate statistics
        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
        
        // Sort for median
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];

        console.log(`✓ ${prices.length} sold items | Avg: £${avgPrice.toFixed(2)} | Median: £${median.toFixed(2)}`);

        const result = {
            averagePrice: Math.round(avgPrice * 100) / 100,
            medianPrice: Math.round(median * 100) / 100,
            minPrice: Math.round(minPrice * 100) / 100,
            maxPrice: Math.round(maxPrice * 100) / 100,
            soldCount: prices.length,
            totalResults: totalResults,
            query: cleanQuery
        };

        // Cache the result
        cache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        return result;

    } catch (error) {
        console.error('❌ eBay Finding API error:', error.response?.data || error.message);
        return null;
    }
}

// ============ API ENDPOINTS ============

// Health check
app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        cacheSize: cache.size,
        timestamp: new Date().toISOString()
    });
});

// Cache stats
app.get('/cache/stats', (req, res) => {
    let validEntries = 0;
    const now = Date.now();
    
    cache.forEach((value) => {
        if (now - value.timestamp < CACHE_DURATION) {
            validEntries++;
        }
    });
    
    res.json({
        totalEntries: cache.size,
        validEntries: validEntries,
        cacheDurationHours: CACHE_DURATION / (60 * 60 * 1000)
    });
});

// Clear cache (useful for testing)
app.post('/cache/clear', (req, res) => {
    cache.clear();
    res.json({ message: 'Cache cleared' });
});

// Main price lookup endpoint
app.post('/api/ebay-price', async (req, res) => {
    const { query } = req.body;

    if (!query) {
        return res.status(400).json({ error: 'Missing query parameter' });
    }

    try {
        const result = await searchEbaySoldItems(query);

        if (result) {
            res.json(result);
        } else {
            res.json({ message: 'No results found', query });
        }
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
});

// GET version for easy testing in browser
app.get('/api/ebay-price', async (req, res) => {
    const query = req.query.q;

    if (!query) {
        return res.status(400).json({ 
            error: 'Missing q parameter', 
            usage: '/api/ebay-price?q=product+name' 
        });
    }

    try {
        const result = await searchEbaySoldItems(query);

        if (result) {
            res.json(result);
        } else {
            res.json({ message: 'No results found', query });
        }
    } catch (error) {
        console.error('API error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ============ START SERVER ============

app.listen(PORT, () => {
    console.log(`🚀 eBay SOLD Price Proxy running on port ${PORT}`);
    console.log(`Using Finding API for completed/sold listings`);
    console.log(`Cache duration: 24 hours`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
