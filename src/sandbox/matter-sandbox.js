'use strict';

/**
 * Matter sandbox module — adds she.matter.* to every script context.
 *
 * Called by loadSandbox() in index.js; receives (she, { scriptDomain, scriptName }).
 *
 * she.matter API:
 *   she.matter.sub(nodeId, endpointId, clusterName, attrName, cb)
 *       → listenerId (number)
 *   she.matter.unsub(listenerId)
 *       → void
 *   she.matter.get(nodeId, endpointId, clusterName, attrName)
 *       → Promise<value>
 *   she.matter.send(nodeId, endpointId, clusterName, command, args?)
 *       → Promise<result>
 *
 * All subscriptions registered by a script are automatically cancelled on
 * hot-reload (cleanup() is called from unloadScript() in index.js).
 */

const controller = require('../matter/controller');

module.exports = function (she, { scriptDomain, scriptName }) {
    she.matter = {
        /**
         * Subscribe to an attribute change on a paired Matter device.
         *
         * @param {string}   nodeId       Decimal NodeId string
         * @param {number}   endpointId
         * @param {string}   clusterName  camelCase cluster name, e.g. "onOff"
         * @param {string}   attrName     camelCase attribute name, e.g. "onOff"
         * @param {Function} callback     (value, oldValue) => void
         * @returns {number}  listenerId
         */
        sub(nodeId, endpointId, clusterName, attrName, callback) {
            try {
                return controller.subscribeAttribute(scriptName, nodeId, endpointId, clusterName, attrName, callback);
            } catch (err) {
                scriptDomain.emit('error', err);
            }
        },

        /**
         * Cancel a specific subscription.
         *
         * @param {number} listenerId  Returned by she.matter.sub()
         */
        unsub(listenerId) {
            controller.unsubscribe(scriptName, listenerId);
        },

        /**
         * Read a single attribute value from a paired Matter device.
         *
         * @param {string} nodeId
         * @param {number} endpointId
         * @param {string} clusterName  camelCase cluster name
         * @param {string} attrName     camelCase attribute name
         * @returns {Promise<unknown>}
         */
        get(nodeId, endpointId, clusterName, attrName) {
            return controller.getAttribute(nodeId, endpointId, clusterName, attrName);
        },

        /**
         * Invoke a cluster command on a paired Matter device.
         *
         * @param {string}  nodeId
         * @param {number}  endpointId
         * @param {string}  clusterName  camelCase cluster name
         * @param {string}  command      camelCase command name
         * @param {object}  [args={}]
         * @returns {Promise<unknown>}
         */
        send(nodeId, endpointId, clusterName, command, args) {
            return controller.sendCommand(nodeId, endpointId, clusterName, command, args ?? {});
        },
    };
};

/**
 * Remove all Matter subscriptions for a script on hot-reload.
 * Called from unloadScript() in index.js.
 *
 * @param {string} scriptName
 */
function cleanup(scriptName) {
    controller.cleanup(scriptName);
}

module.exports.cleanup = cleanup;
