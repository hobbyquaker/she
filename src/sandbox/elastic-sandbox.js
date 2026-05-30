'use strict';

const elastic = require('../elastic');

/**
 * Sandbox module — adds she.elastic.* to every script context.
 *
 * All methods return Promises and are no-ops (returning empty / null results)
 * when Elasticsearch is not configured (no --elastic.node in config).
 *
 * she.elastic API:
 *   she.elastic.search(index, query)           → Promise<{ hits, total }>
 *   she.elastic.get(index, id)                 → Promise<object|null>
 *   she.elastic.index(index, doc, [id])        → Promise<{ id }>
 *   she.elastic.find(index, field, text, size) → Promise<object[]>
 */
module.exports = function (she) {
    she.elastic = {
        /**
         * Search documents in an Elasticsearch index.
         * @param {string} index
         * @param {object} query  Elasticsearch query DSL object
         * @returns {Promise<{ hits: object[], total: number }>}
         */
        async search(index, query) {
            const client = elastic.getClient();
            if (!client) return { hits: [], total: 0 };
            const result = await client.search({ index, query });
            return {
                hits: result.hits.hits.map((h) => ({ id: h._id, ...h._source })),
                total: result.hits.total?.value ?? result.hits.hits.length,
            };
        },

        /**
         * Retrieve a single document by ID.
         * @param {string} index
         * @param {string} id
         * @returns {Promise<object|null>}
         */
        async get(index, id) {
            const client = elastic.getClient();
            if (!client) return null;
            try {
                const result = await client.get({ index, id });
                return result._source ?? null;
            } catch (err) {
                if (err.statusCode === 404) return null;
                throw err;
            }
        },

        /**
         * Index (create or replace) a document.
         * @param {string} index
         * @param {object} doc
         * @param {string} [id]  omit to let Elasticsearch auto-generate an ID
         * @returns {Promise<{ id: string }>}
         */
        async index(index, doc, id) {
            const client = elastic.getClient();
            if (!client) return { id: null };
            const params = { index, document: doc };
            if (id !== undefined) params.id = id;
            const result = await client.index(params);
            return { id: result._id };
        },

        /**
         * Full-text match search across a single field.
         * @param {string} index
         * @param {string} field
         * @param {string} text
         * @param {number} [size=10]
         * @returns {Promise<object[]>}
         */
        async find(index, field, text, size) {
            const client = elastic.getClient();
            if (!client) return [];
            const result = await client.search({
                index,
                size: size ?? 10,
                query: { match: { [field]: text } },
            });
            return result.hits.hits.map((h) => ({ id: h._id, ...h._source }));
        },
    };
};
