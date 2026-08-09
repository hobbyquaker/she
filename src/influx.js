'use strict';

let _client = null; // v2 client (@influxdata/influxdb-client)
let _opts = null;
let _mode = null; // 'v1' | 'v2' | null

const V1_TIMEOUT_MS = 10000;

function v1Timeout() {
    return Number(_opts.timeout) || V1_TIMEOUT_MS;
}

/**
 * Initialise the InfluxDB client.  Called from index.js when config.influx is set.
 *
 * v2 (token/org/bucket):      { url, token, org, bucket }
 * v1 (database/user/password): { url, database, username?, password?, retentionPolicy?, version?: 1 }
 *
 * The API version is taken from opts.version when present; otherwise it is
 * inferred: a `database` key (and no `token`) means v1, a `token` means v2.
 * @param {object} opts
 */
function init(opts) {
    if (!opts || !opts.url) return;
    const version = Number(opts.version) || (opts.database && !opts.token ? 1 : 2);
    if (version === 1) {
        if (!opts.database) return;
        _opts = opts;
        _mode = 'v1';
        return;
    }
    if (!opts.token) return;
    const { InfluxDB } = require('@influxdata/influxdb-client');
    _opts = opts;
    _mode = 'v2';
    _client = new InfluxDB({ url: opts.url, token: opts.token });
}

function getClient() {
    return _client;
}

function getOpts() {
    return _opts;
}

/** @returns {'v1'|'v2'|null} */
function getMode() {
    return _mode;
}

// ── v1 (InfluxDB 1.x) HTTP API ──────────────────────────────────────────────

function v1Headers() {
    const headers = {};
    if (_opts.username) {
        headers.Authorization = 'Basic ' + Buffer.from(`${_opts.username}:${_opts.password || ''}`).toString('base64');
    }
    return headers;
}

/**
 * Escape a measurement name for line protocol (commas and spaces).
 * @param {string} s
 */
function escapeMeasurement(s) {
    return String(s).replace(/,/g, '\\,').replace(/ /g, '\\ ');
}

/**
 * Escape a tag key, tag value or field key for line protocol (commas, equals signs, spaces).
 * @param {string} s
 */
function escapeTag(s) {
    return String(s).replace(/,/g, '\\,').replace(/=/g, '\\=').replace(/ /g, '\\ ');
}

/**
 * Serialise a field value for line protocol: booleans and finite numbers pass
 * through natively, everything else becomes a quoted string.
 * @param {*} v
 */
function fieldValue(v) {
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/**
 * Build a single line-protocol line.
 * @param {string} measurement
 * @param {object} fields          e.g. { temperature: 21.5 }
 * @param {object} [tags]          e.g. { room: 'living' }
 * @param {Date|number} [timestamp] ms precision
 * @returns {string}
 */
function buildLine(measurement, fields, tags, timestamp) {
    let line = escapeMeasurement(measurement);
    if (tags) {
        for (const [k, v] of Object.entries(tags)) line += `,${escapeTag(k)}=${escapeTag(v)}`;
    }
    line +=
        ' ' +
        Object.entries(fields)
            .map(([k, v]) => `${escapeTag(k)}=${fieldValue(v)}`)
            .join(',');
    if (timestamp !== undefined) {
        const ts = timestamp instanceof Date ? timestamp.getTime() : Number(timestamp);
        line += ' ' + ts;
    }
    return line;
}

/**
 * Write line-protocol data via the v1 endpoint (POST /write?db=…&precision=ms).
 * @param {string} lines one or more line-protocol lines, newline-separated
 * @returns {Promise<void>}
 */
async function v1Write(lines) {
    const params = new URLSearchParams({ db: _opts.database, precision: 'ms' });
    if (_opts.retentionPolicy) params.set('rp', _opts.retentionPolicy);
    const res = await fetch(`${_opts.url.replace(/\/$/, '')}/write?${params}`, {
        method: 'POST',
        headers: v1Headers(),
        body: lines,
        signal: AbortSignal.timeout(v1Timeout()),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`influx v1 write failed: HTTP ${res.status} ${body}`.trim());
    }
}

/**
 * Run an InfluxQL query via the v1 endpoint (GET /query?db=…&q=…&epoch=ms) and
 * flatten the result into plain row objects: one object per value row, with the
 * series' columns as keys, series tags merged in, and the measurement name as
 * `_measurement`. `time` is a millisecond timestamp (epoch=ms).
 * @param {string} q InfluxQL query
 * @returns {Promise<object[]>}
 */
async function v1Query(q) {
    const params = new URLSearchParams({ db: _opts.database, q, epoch: 'ms' });
    const res = await fetch(`${_opts.url.replace(/\/$/, '')}/query?${params}`, {
        headers: v1Headers(),
        signal: AbortSignal.timeout(v1Timeout()),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`influx v1 query failed: HTTP ${res.status} ${body}`.trim());
    }
    const json = await res.json();
    const rows = [];
    for (const result of json.results || []) {
        if (result.error) throw new Error(`influx v1 query failed: ${result.error}`);
        for (const series of result.series || []) {
            for (const values of series.values || []) {
                const row = { _measurement: series.name, ...series.tags };
                series.columns.forEach((col, i) => {
                    row[col] = values[i];
                });
                rows.push(row);
            }
        }
    }
    return rows;
}

/**
 * Escape a string for use inside an InfluxQL single-quoted string literal.
 * @param {string} s
 */
function escapeQL(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Escape a string for use inside an InfluxQL double-quoted identifier
 * (measurement/tag/field name).
 * @param {string} s
 */
function escapeIdent(s) {
    return String(s).replace(/"/g, '\\"');
}

module.exports = { init, getClient, getOpts, getMode, buildLine, v1Write, v1Query, escapeQL, escapeIdent };
