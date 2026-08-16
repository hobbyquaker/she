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
 * nodeId   — decimal NodeId string (e.g. '4') OR device name (e.g. 'Matterbridge')
 * endpointId — numeric endpoint id (e.g. 43) OR endpoint name (e.g. 'Licht Werkstatt')
 * Name matching uses basicInformation.nodeLabel / productName for devices and
 * bridgedDeviceBasicInformation.nodeLabel / basicInformation.nodeLabel for endpoints.
 *
 * All subscriptions registered by a script are automatically cancelled on
 * hot-reload (cleanup() is called from unloadScript() in index.js).
 */

const controller = require('../matter/controller');

module.exports = function (she, { scriptDomain, scriptName, scriptFile }) {
    // Use full file path as the tracking key so cleanup() called from
    // unloadScript() (which passes the full path) matches what was registered.
    const trackingKey = scriptFile || scriptName;
    she.matter = {
        /**
         * Subscribe to an attribute change on a paired Matter device.
         *
         * @param {string|number} nodeId       Decimal NodeId string/number OR device name
         * @param {number|string} endpointId   Numeric endpoint id OR endpoint name
         * @param {string}        clusterName  camelCase cluster name, e.g. "onOff"
         * @param {string}        attrName     camelCase attribute name, e.g. "onOff"
         * @param {Function}      callback     (value, oldValue) => void
         * @returns {number}  listenerId
         */
        sub(nodeId, endpointId, clusterName, attrName, callback) {
            // Wrap so callback errors (sync and async) are logged with the
            // script's label — she.error carries the label, which also routes
            // the line into the script's log panel in the Scripts tab (S1).
            const wrapped = (value, oldValue) => {
                try {
                    const result = callback(value, oldValue);
                    if (result && typeof result.then === 'function' && typeof result.catch === 'function') {
                        result.catch((err) => she.error('async callback error:', err instanceof Error ? (err.stack ?? err.message) : String(err)));
                    }
                } catch (err) {
                    she.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
                }
            };
            try {
                return controller.subscribeAttribute(trackingKey, nodeId, endpointId, clusterName, attrName, wrapped);
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
            controller.unsubscribe(trackingKey, listenerId);
        },

        /**
         * Read a single attribute value from a paired Matter device.
         *
         * @param {string|number} nodeId       Decimal NodeId string/number OR device name
         * @param {number|string} endpointId   Numeric endpoint id OR endpoint name
         * @param {string}        clusterName  camelCase cluster name
         * @param {string}        attrName     camelCase attribute name
         * @returns {Promise<unknown>}
         */
        get(nodeId, endpointId, clusterName, attrName) {
            return controller.getAttribute(nodeId, endpointId, clusterName, attrName);
        },

        /**
         * Invoke a cluster command on a paired Matter device.
         *
         * @param {string|number} nodeId       Decimal NodeId string/number OR device name
         * @param {number|string} endpointId   Numeric endpoint id OR endpoint name
         * @param {string}        clusterName  camelCase cluster name
         * @param {string}        command      camelCase command name
         * @param {object}        [args]       Command arguments (omit for void commands)
         * @returns {Promise<unknown>}
         */
        send(nodeId, endpointId, clusterName, command, args) {
            return controller.sendCommand(nodeId, endpointId, clusterName, command, args);
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
