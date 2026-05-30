'use strict';

let _client = null;

/**
 * Initialise the Elasticsearch client.  Called from index.js when config.elastic is set.
 * @param {{ node: string, auth?: object }} opts
 */
function init(opts) {
    if (!opts || !opts.node) return;
    const { Client } = require('@elastic/elasticsearch');
    _client = new Client({ node: opts.node, ...(opts.auth ? { auth: opts.auth } : {}) });
}

function getClient() {
    return _client;
}

module.exports = { init, getClient };
