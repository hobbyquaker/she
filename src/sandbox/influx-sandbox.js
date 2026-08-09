'use strict';

const influx = require('../influx');

/**
 * Sandbox module — adds she.influx.* to every script context.
 *
 * Works against InfluxDB 2.x (url/token/org/bucket → Flux) and InfluxDB 1.x
 * (url/database/username/password → InfluxQL over the v1 HTTP API).
 *
 * All methods return Promises and are no-ops (returning empty results) when
 * InfluxDB is not configured (no influx block in config).
 *
 * she.influx API:
 *   she.influx.query(query)                             → Promise<object[]>
 *       (Flux in v2 mode, InfluxQL in v1 mode)
 *   she.influx.write(measurement, fields, tags, ts)     → Promise<void>
 *   she.influx.getLast(topic, n)                        → Promise<{ ts, val }[]>
 *   she.influx.getRange(topic, from, to)                → Promise<{ ts, val }[]>
 */

/**
 * Extract the value from a v1 result row: prefer the conventional "value"
 * (then "val") field, otherwise take the first column that is not time/topic
 * metadata.
 * @param {object} row
 */
function v1RowVal(row) {
    if (row.value !== undefined && row.value !== null) return row.value;
    if (row.val !== undefined && row.val !== null) return row.val;
    for (const [k, v] of Object.entries(row)) {
        if (k === 'time' || k === 'topic' || k === '_measurement' || v === null || v === undefined) continue;
        return v;
    }
    return null;
}

/**
 * Map v1 result rows to the { ts, val } shape, newest-trimmed to n (LIMIT
 * applies per series in InfluxQL, so multi-series results must be merged and
 * re-trimmed), sorted oldest-first.
 * @param {object[]} rows
 * @param {number} [n]
 */
function v1Points(rows, n) {
    const pts = rows.map((r) => ({ ts: r.time, val: v1RowVal(r) })).sort((a, b) => b.ts - a.ts);
    return (n ? pts.slice(0, Number(n)) : pts).reverse();
}

module.exports = function (she) {
    she.influx = {
        /**
         * Execute a query against InfluxDB — a Flux query in v2 mode, an
         * InfluxQL query in v1 mode.
         * @param {string} query
         * @returns {Promise<object[]>}
         */
        query(query) {
            const mode = influx.getMode();
            if (!mode) return Promise.resolve([]);
            if (mode === 'v1') return influx.v1Query(query);
            const client = influx.getClient();
            const opts = influx.getOpts();
            const queryApi = client.getQueryApi(opts.org);
            return new Promise((resolve, reject) => {
                const rows = [];
                queryApi.queryRows(query, {
                    next(row, tableMeta) {
                        rows.push(tableMeta.toObject(row));
                    },
                    error: reject,
                    complete() {
                        resolve(rows);
                    },
                });
            });
        },

        /**
         * Write a single data point to InfluxDB.
         * @param {string} measurement
         * @param {object} fields       e.g. { temperature: 21.5 }
         * @param {object} [tags]       e.g. { room: 'living' }
         * @param {Date|number} [timestamp]
         * @returns {Promise<void>}
         */
        write(measurement, fields, tags, timestamp) {
            const mode = influx.getMode();
            if (!mode) return Promise.resolve();
            if (mode === 'v1') {
                return influx.v1Write(influx.buildLine(measurement, fields, tags, timestamp));
            }
            const client = influx.getClient();
            const opts = influx.getOpts();
            const { Point } = require('@influxdata/influxdb-client');
            const writeApi = client.getWriteApi(opts.org, opts.bucket, 'ns');
            const point = new Point(measurement);
            if (tags) {
                Object.entries(tags).forEach(([k, v]) => point.tag(k, v));
            }
            Object.entries(fields).forEach(([k, v]) => {
                if (typeof v === 'boolean') {
                    point.booleanField(k, v);
                } else if (typeof v === 'number') {
                    point.floatField(k, v);
                } else {
                    point.stringField(k, String(v));
                }
            });
            if (timestamp !== undefined) point.timestamp(timestamp);
            writeApi.writePoint(point);
            return writeApi.close();
        },

        /**
         * Return the last N recorded values for an MQTT topic (last 30 days).
         * v2: assumes points carry a "topic" tag, value from "_value".
         * v1: tries a measurement named like the topic first (influx4mqtt-style
         * schema), then falls back to a "topic" tag scan; value from the
         * "value" field, falling back to the first data column.
         * Results are sorted oldest-first.
         * @param {string} topic
         * @param {number} n
         * @returns {Promise<{ ts: number, val: any }[]>}
         */
        getLast(topic, n) {
            const mode = influx.getMode();
            if (!mode) return Promise.resolve([]);
            if (mode === 'v1') {
                // Fast path: measurement named like the topic (the common
                // mqtt-to-influx v1 schema, e.g. influx4mqtt). Fallback: points
                // stored with a "topic" tag — that needs a scan across all
                // measurements, so keep it time-bounded (30d, like the v2 path).
                const mQl = `SELECT * FROM "${influx.escapeIdent(topic)}" WHERE time >= now() - 30d ORDER BY time DESC LIMIT ${Number(n)}`;
                return influx.v1Query(mQl).then((rows) => {
                    if (rows.length) return v1Points(rows, n);
                    const tagQl = `SELECT * FROM /.*/ WHERE "topic" = '${influx.escapeQL(topic)}' AND time >= now() - 30d ORDER BY time DESC LIMIT ${Number(n)}`;
                    return influx.v1Query(tagQl).then((tagRows) => v1Points(tagRows, n));
                });
            }
            const opts = influx.getOpts();
            const safeTopic = topic.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const flux = `from(bucket: "${opts.bucket}")` + ` |> range(start: -30d)` + ` |> filter(fn: (r) => r["topic"] == "${safeTopic}")` + ` |> tail(n: ${Number(n)})`;
            return this.query(flux).then((rows) => rows.map((r) => ({ ts: new Date(r._time).getTime(), val: r._value })));
        },

        /**
         * Return all recorded values for an MQTT topic within a time range.
         * @param {string} topic
         * @param {Date|string|number} from
         * @param {Date|string|number} to
         * @returns {Promise<{ ts: number, val: any }[]>}
         */
        getRange(topic, from, to) {
            const mode = influx.getMode();
            if (!mode) return Promise.resolve([]);
            if (mode === 'v1') {
                const fromMs = new Date(from).getTime();
                const toMs = new Date(to).getTime();
                const bounds = `time >= ${fromMs}ms AND time <= ${toMs}ms`;
                const mQl = `SELECT * FROM "${influx.escapeIdent(topic)}" WHERE ${bounds}`;
                return influx.v1Query(mQl).then((rows) => {
                    if (rows.length) return v1Points(rows);
                    const tagQl = `SELECT * FROM /.*/ WHERE "topic" = '${influx.escapeQL(topic)}' AND ${bounds}`;
                    return influx.v1Query(tagQl).then((tagRows) => v1Points(tagRows));
                });
            }
            const opts = influx.getOpts();
            const safeTopic = topic.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const start = new Date(from).toISOString();
            const stop = new Date(to).toISOString();
            const flux = `from(bucket: "${opts.bucket}")` + ` |> range(start: ${start}, stop: ${stop})` + ` |> filter(fn: (r) => r["topic"] == "${safeTopic}")`;
            return this.query(flux).then((rows) => rows.map((r) => ({ ts: new Date(r._time).getTime(), val: r._value })));
        },
    };
};
