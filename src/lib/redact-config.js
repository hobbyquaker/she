'use strict';

/**
 * A copy of the configuration that is safe to log.
 *
 * The daemon debug-logs its configuration at startup. The object carries the broker URL with
 * its credentials, the UI password hash, API keys and tokens of the integrations (Influx,
 * Elasticsearch, the AI model, dynsec, additional brokers), so the raw object must never reach
 * a log line. This module masks every value whose key names a secret, strips the userinfo from
 * every URL-shaped string, and drops yargs' bookkeeping (`_`, `$0`, the kebab-case and
 * single-letter twins of the camelCase options) so the line stays readable.
 */

const MASK = '***';

/** Keys whose value is a secret wherever they appear in the tree (matched case-insensitively). */
const SECRET_KEY_RE = /(password|passwd|secret|token|apikey|api_key|privatekey|passphrase|credential)/i;
/** Keys that end in "key" are secrets too (apiKey, secretsKey, mqttKey …), "keys" is a plural list, not one. */
const KEY_SUFFIX_RE = /key$/i;

/** Strip user:password@ from a URL; a string that is not a URL is returned as it is. */
function redactUrl(value) {
    // greedy up to the last "@" before the first "/" after the scheme: a password may itself contain "@";
    // a plain string replacement keeps the rest of the URL as written (new URL() would normalise it)
    return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, `$1${MASK}:${MASK}@`);
}

function isSecretKey(key) {
    return SECRET_KEY_RE.test(key) || KEY_SUFFIX_RE.test(key);
}

function redactValue(key, value, depth) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
        if (isSecretKey(key)) return value === '' ? value : MASK;
        return redactUrl(value);
    }
    if (typeof value !== 'object') return isSecretKey(key) ? MASK : value;
    if (depth > 8) return '[…]';
    if (Array.isArray(value)) return value.map((v) => redactValue(key, v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(k, v, depth + 1);
    return out;
}

/**
 * yargs leaves every option under its kebab-case name and its camelCase alias, plus the positional
 * list `_`, the script name `$0` and single-letter aliases. Keep one spelling per option.
 */
function stripYargsNoise(config) {
    const out = {};
    const keys = Object.keys(config);
    for (const key of keys) {
        if (key === '_' || key === '$0') continue;
        if (key.length === 1) continue;
        if (key.includes('-')) {
            const camel = key.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
            if (camel !== key && keys.includes(camel)) continue;
        }
        out[key] = config[key];
    }
    return out;
}

/**
 * @param {object} config the parsed configuration
 * @returns {object} a deep copy with secrets masked and URL credentials stripped
 */
function redactConfig(config) {
    if (!config || typeof config !== 'object') return config;
    return redactValue('', stripYargsNoise(config), 0);
}

module.exports = { redactConfig, redactUrl, isSecretKey, MASK };
