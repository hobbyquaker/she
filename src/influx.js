'use strict';

let _client = null;
let _opts = null;

/**
 * Initialise the InfluxDB client.  Called from index.js when config.influx is set.
 * @param {{ url: string, token: string, org: string, bucket: string }} opts
 */
function init(opts) {
    if (!opts || !opts.url || !opts.token) return;
    const { InfluxDB } = require('@influxdata/influxdb-client');
    _opts = opts;
    _client = new InfluxDB({ url: opts.url, token: opts.token });
}

function getClient() {
    return _client;
}

function getOpts() {
    return _opts;
}

module.exports = { init, getClient, getOpts };
