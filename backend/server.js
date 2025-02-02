require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const rateLimit = require('express-rate-limit');
const cache = require('memory-cache');

const app = express();

// Enable CORS for all routes
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
    
    // Handle preflight requests
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Root endpoint
app.get('/', (req, res) => {
    res.json({
        message: 'X Spaces API is running',
        endpoints: {
            users: '/api/user/:username',
            spaces: '/api/spaces/:userId'
        }
    });
});

// More restrictive rate limit
const limiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10 // limit each IP to 10 requests per hour
});

app.use(limiter);

// Exponential backoff function
const fetchWithRetry = async (url, options, maxRetries = 3) => {
    for (let i = 0; i < maxRetries; i++) {
        try {
            const delay = Math.pow(2, i) * 1000; // 1s, 2s, 4s
            await new Promise(resolve => setTimeout(resolve, delay));
            
            const response = await fetch(url, options);
            if (response.status === 429) {
                console.log(`Rate limited, attempt ${i + 1} of ${maxRetries}`);
                continue;
            }
            return response;
        } catch (error) {
            if (i === maxRetries - 1) throw error;
        }
    }
    throw new Error('Max retries reached');
};

// Cache middleware with longer duration
const cacheMiddleware = (duration) => {
    return (req, res, next) => {
        const key = '__express__' + req.originalUrl || req.url;
        const cachedBody = cache.get(key);
        
        if (cachedBody) {
            console.log('Returning cached response for:', key);
            return res.json(cachedBody);
        }
        
        res.sendResponse = res.json;
        res.json = (body) => {
            if (body.data) { // Only cache successful responses
                cache.put(key, body, duration * 1000);
                console.log('Caching response for:', key);
            }
            res.sendResponse(body);
        }
        next();
    }
};

// Get user by username (with 30 minute cache)
app.get("/api/user/:username", cacheMiddleware(1800), async (req, res) => {
    try {
        const username = req.params.username.replace('@', '');
        console.log('Looking up user:', username);

        const url = `https://api.twitter.com/2/users/by/username/${username}?user.fields=profile_image_url`;
        const response = await fetchWithRetry(url, {
            headers: {
                "Authorization": `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
            }
        });

        console.log('API Response status:', response.status);
        const data = await response.json();

        if (data.errors || !data.data) {
            console.log('API Error or no data:', data);
            return res.status(404).json({ error: 'User not found' });
        }

        res.json(data);
    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ error: error.message });
    }
});

// Get user's spaces (with 5 minute cache)
app.get("/api/spaces/:userId", cacheMiddleware(300), async (req, res) => {
    try {
        const url = `https://api.twitter.com/2/spaces/by/creator_ids?user_ids=${req.params.userId}&space.fields=title,scheduled_start,participant_count,state`;
        const response = await fetchWithRetry(url, {
            headers: {
                "Authorization": `Bearer ${process.env.TWITTER_BEARER_TOKEN}`
            }
        });
        
        const data = await response.json();
        res.json(data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const startServer = async (port) => {
    try {
        await app.listen(port);
        console.log(`Server is running on port ${port}`);
    } catch (err) {
        if (err.code === 'EADDRINUSE') {
            console.log(`Port ${port} is busy, trying ${port + 1}`);
            await startServer(port + 1);
        } else {
            console.error('Server error:', err);
        }
    }
};

startServer(3001);
