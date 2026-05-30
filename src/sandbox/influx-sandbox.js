'use strict';

const influx = require('../influx');

/**
 * Sandbox module — adds she.influx.* to every script context.
 *
 * All methods return Promises and are no-ops (returning empty results) when
 * InfluxDB is not configured (no --influx.url / --influx.token in config).
 *
 * she.influx API:
 *   she.influx.query(fluxQuery)                         → Promise<object[]>
 *   she.influx.write(measurement, fields, tags, ts)     → Promise<void>
 *   she.influx.getLast(topic, n)                        → Promise<{ ts, val }[]>
 *   she.influx.getRange(topic, from, to)                → Promise<{ ts, val }[]>
 */
module.exports = function (she) {
    she.influx = {
        /**
         * Execute a Flux query against InfluxDB.
         * @param {string} fluxQuery
         * @returns {Promise<object[]>}
         */
        query(fluxQuery) {
            const client = influx.getClient();
            const opts = influx.getOpts();
            if (!client) return Promise.resolve([]);
            const queryApi = client.getQueryApi(opts.org);
            return new Promise((resolve, reject) => {
                const rows = [];
                queryApi.queryRows(fluxQuery, {
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
            const client = influx.getClient();
            const opts = influx.getOpts();
            if (!client) return Promise.resolve();
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
         * Return the last N recorded values for an MQTT topic.
         * Assumes data was stored with a "topic" tag and value in the "_value" field.
         * @param {string} topic
         * @param {number} n
         * @returns {Promise<{ ts: number, val: any }[]>}
         */
        getLast(topic, n) {
            const opts = influx.getOpts();
            if (!opts) return Promise.resolve([]);
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
            const opts = influx.getOpts();
            if (!opts) return Promise.resolve([]);
            const safeTopic = topic.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
            const start = new Date(from).toISOString();
            const stop = new Date(to).toISOString();
            const flux = `from(bucket: "${opts.bucket}")` + ` |> range(start: ${start}, stop: ${stop})` + ` |> filter(fn: (r) => r["topic"] == "${safeTopic}")`;
            return this.query(flux).then((rows) => rows.map((r) => ({ ts: new Date(r._time).getTime(), val: r._value })));
        },
    };
};
