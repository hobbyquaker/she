'use strict';

let client = null;

/**
 * Initialize the Redis write-through cache.
 * Seeds StateStore from Redis on startup, then writes every store change back.
 *
 * Config: config.json → { "redis": { "url": "redis://localhost:6379" } }
 *
 * @param {object} opts
 * @param {string} opts.url   - Redis URL
 * @param {object} opts.store - StateStore instance
 * @param {object} opts.log   - Logger
 * @returns {Promise<void>}
 */
async function init({ url, store, log }) {
    let Redis;
    try {
        Redis = require('ioredis');
    } catch {
        log.error('redis: ioredis not installed — run: npm install ioredis');
        return;
    }

    client = new Redis(url, { lazyConnect: true });

    client.on('error', (err) => {
        log.error('redis error:', err.message);
    });

    try {
        await client.connect();
    } catch (err) {
        log.error('redis: connect failed:', err.message);
        return;
    }

    // Seed StateStore from Redis hash on startup
    try {
        const hash = await client.hgetall('she:state');
        if (hash) {
            let count = 0;
            for (const [key, json] of Object.entries(hash)) {
                try {
                    const obj = JSON.parse(json);
                    store.setObject(key, obj);
                    count++;
                } catch {
                    log.warn('redis: skipping invalid JSON for key', key);
                }
            }
            log.info('redis: seeded', count, 'keys from she:state');
        }
    } catch (err) {
        log.error('redis: seed failed:', err.message);
    }

    // Write-through: every StateStore change → Redis hset
    store.on('change', (key, _val, obj) => {
        client.hset('she:state', key, JSON.stringify(obj)).catch((err) => {
            log.error('redis: hset failed:', err.message);
        });
    });

    log.info('redis: connected', url);
}

/** @returns {import('ioredis').Redis | null} */
function getClient() {
    return client;
}

module.exports = { init, getClient };
