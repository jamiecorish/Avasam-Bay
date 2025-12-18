// server.js - eBay Finding API with OAuth for SOLD listings
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Simple in-memory cache (24 hour expiry)
const cache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000;

// OAuth token cache
let oauthToken = null;
let tokenExpiry = 0;

// Middleware
app.use(cors());
app.use(express.json());

// ============ OAUTH TOKEN ============

async function getOAuthToken() {
    if (oauthToken && Date.now() < tokenExpiry) {
        return oauthToken;
    }

    const clientId = process.env.EBAY_CLIENT_ID;
    const clientSecret = process.env.EBAY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error('Missing EBAY_CLIENT_ID or EBAY_CLIENT_SECRET');
    }

    try {
        console.log('🔑 Getting OAuth token...');
       
        const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
       
        const response = await axios.post(
            'https://api.ebay.com/identity/v1/oauth2/token',
            'grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope',
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${credentials}`
                }
            }
        );

        oauthToken = response.data.access_token;
        tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);
       
        console.log('✅ OAuth token obtained');
        return oauthToken;

    } catch (error) {
        console.error('❌ OAuth error:', error.response?.data || error.message);
        throw new Error('Failed to get OAuth token');
    }
}

// ============ EBAY FINDING API - SOLD ITEMS ============

async function searchEbaySoldItems(query) {
    const cacheKey = query.toLowerCase().trim();
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
        console.log(`✓ Cache hit for: "${query}"`);
        return { ...cached.data, fromCache: true };
    }

    let cleanQuery = query
        .replace(/[^\w\s\-\.]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .substring(0, 100);

    console.log(`🔍 Searching eBay SOLD listings for: "${cleanQuery}"`);

    try {
        const token = await getOAuthToken();

        // Finding API still works but needs OAuth token in header
        const response = await axios.get('https://svcs.ebay.com/services/search/FindingService/v1', {
            headers: {
                'X-EBAY-SOA-SECURITY-TOKEN': token,
                'X-EBAY-SOA-OPERATION-NAME': 'findCompletedItems'
            },
            params: {
                'OPERATION-NAME': 'findCompletedItems',
                'SERVICE-VERSION': '1.13.0',
                'SECURITY-APPNAME': process.env.EBAY_CLIENT_ID,
                'RESPONSE-DATA-FORMAT': 'JSON',
                'REST-PAYLOAD': '',
                'keywords': cleanQuery,
                'itemFilter(0).name': 'SoldItemsOnly',
                'itemFilter(0).value': 'true',
                'itemFilter(1).name': 'Condition',
                'itemFilter(1).value': '1000',
                'itemFilter(2).name': 'LocatedIn',
                'itemFilter(2).value': 'GB',
                'sortOrder': 'EndTimeSoonest',
                'paginationInput.entriesPerPage': '100',
                'GLOBAL-ID': 'EBAY-GB'
            }
        });

        const searchResult = response.data?.findCompletedItemsResponse?.[0]?.searchResult?.[0];
        const items = searchResult?.item || [];
        const totalResults = parseInt(searchResult?.['@count'] || '0');

        console.log(`Found ${items.length} sold items`);

        if (items.length === 0) {
            return null;
        }

        const prices = items
            .map(item => {
                const priceData = item.sellingStatus?.[0]?.currentPrice?.[0];
                if (priceData && priceData['@currencyId'] === 'GBP') {
                    return parseFloat(priceData['__value__']);
                }
                return null;
            })
            .filter(p => p !== null && p > 0 && p < 10000);

        if (prices.length === 0) {
            return null;
        }

        const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
        const minPrice = Math.min(...prices);
        const maxPrice = Math.max(...prices);
       
        const sorted = [...prices].sort((a, b) => a - b);
        const median = sorted.length % 2 === 0
            ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
            : sorted[Math.floor(sorted.length / 2)];

        console.log(`✓ ${prices.length} sold | Avg: £${avgPrice.toFixed(2)} | Median: £${median.toFixed(2)}`);

        const result = {
            averagePrice: Math.round(avgPrice * 100) / 100,
            medianPrice: Math.round(median * 100) / 100,
            minPrice: Math.round(minPrice * 100) / 100,
            maxPrice: Math.round(maxPrice * 100) / 100,
            soldCount: prices.length,
            totalResults: totalResults,
            query: cleanQuery
        };

        cache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
        });

        return result;

    } catch (error) {
        console.error('❌ eBay API error:', error.response?.data || error.message);
       
        if (error.response?.status === 401) {
            oauthToken = null;
            tokenExpiry = 0;
        }
       
        return null;
    }
}

// ============ API ENDPOINTS ============

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        cacheSize: cache.size,
        hasToken: !!oauthToken,
        timestamp: new Date().toISOString()
    });
});

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

app.post('/cache/clear', (req, res) => {
    cache.clear();
    res.json({ message: 'Cache cleared' });
});

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
    console.log(`🚀 eBay SOLD Price API running on port ${PORT}`);
    console.log(`Using Finding API with OAuth for completed listings`);
    console.log(`Health: http://localhost:${PORT}/health`);
});
