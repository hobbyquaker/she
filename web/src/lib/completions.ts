/**
 * Monaco completion providers for the she sandbox API.
 *
 * Provides value-level suggestions for:
 *  - MQTT topics   (she.mqtt.sub/pub/get/set/link/age/getProp)
 *  - sheDB doc IDs (she.db.get/set/extend/delete/sub/prop/query)
 *  - sheDB view IDs (she.db.sub pattern, same trigger)
 *  - Matter         (she.matter.sub/get/send/on → nodeId → endpointId → cluster → attr/cmd)
 *
 * The she_dts extra-lib already covers method/property completions on the `she` object.
 */

import * as monaco from 'monaco-editor';
import {
    fetchMqttState,
    listDocs,
    listViews,
    listMatterDevices,
    getMatterDevice,
    type MatterNodeDetail,
} from './api.js';

// ── Matter cluster schema ─────────────────────────────────────────────────────
// Attributes and commands for the most common Matter clusters (standard-defined).
const CLUSTER_ATTRS: Record<string, string[]> = {
    OnOff:                      ['onOff', 'globalSceneControl', 'onTime', 'offWaitTime'],
    LevelControl:               ['currentLevel', 'remainingTime', 'minLevel', 'maxLevel', 'currentFrequency', 'onOffTransitionTime', 'onLevel'],
    ColorControl:               ['currentHue', 'currentSaturation', 'remainingTime', 'currentX', 'currentY', 'colorTemperatureMireds', 'colorMode', 'colorTempPhysicalMinMireds', 'colorTempPhysicalMaxMireds'],
    BasicInformation:           ['vendorName', 'vendorId', 'productName', 'productId', 'nodeLabel', 'location', 'softwareVersion', 'softwareVersionString', 'serialNumber'],
    Identify:                   ['identifyTime', 'identifyType'],
    Groups:                     ['nameSupport'],
    OccupancySensing:           ['occupancy', 'occupancySensorType'],
    IlluminanceMeasurement:     ['measuredValue', 'minMeasuredValue', 'maxMeasuredValue', 'tolerance', 'lightSensorType'],
    TemperatureMeasurement:     ['measuredValue', 'minMeasuredValue', 'maxMeasuredValue', 'tolerance'],
    RelativeHumidityMeasurement:['measuredValue', 'minMeasuredValue', 'maxMeasuredValue', 'tolerance'],
    PressureMeasurement:        ['measuredValue', 'minMeasuredValue', 'maxMeasuredValue'],
    Thermostat:                 ['localTemperature', 'outdoorTemperature', 'occupiedCoolingSetpoint', 'occupiedHeatingSetpoint', 'unoccupiedCoolingSetpoint', 'unoccupiedHeatingSetpoint', 'minHeatSetpointLimit', 'maxHeatSetpointLimit', 'systemMode', 'thermostatRunningMode', 'occupancy'],
    DoorLock:                   ['lockState', 'lockType', 'actuatorEnabled', 'doorState'],
    WindowCovering:             ['type', 'currentPositionLiftPercent100ths', 'currentPositionTiltPercent100ths', 'operationalStatus', 'targetPositionLiftPercent100ths', 'targetPositionTiltPercent100ths', 'endProductType', 'mode'],
    FanControl:                 ['fanMode', 'fanModeSequence', 'percentSetting', 'percentCurrent', 'speedMax', 'speedSetting', 'speedCurrent'],
    Descriptor:                 ['deviceTypeList', 'serverList', 'clientList', 'partsList'],
    PowerSource:                ['status', 'order', 'description', 'wiredCurrentType', 'wiredMaximumCurrent', 'batteryVoltage', 'batteryPercentRemaining', 'batChargeLevel'],
    Switch:                     ['numberOfPositions', 'currentPosition', 'multiPressMax'],
    BooleanState:               ['stateValue'],
    FlowMeasurement:            ['measuredValue', 'minMeasuredValue', 'maxMeasuredValue'],
};

const CLUSTER_CMDS: Record<string, string[]> = {
    OnOff:          ['on', 'off', 'toggle'],
    LevelControl:   ['moveToLevel', 'move', 'step', 'stop', 'moveToLevelWithOnOff', 'moveWithOnOff', 'stepWithOnOff', 'stopWithOnOff'],
    ColorControl:   ['moveToHue', 'moveHue', 'stepHue', 'moveToSaturation', 'moveSaturation', 'stepSaturation', 'moveToHueAndSaturation', 'moveToColor', 'moveColor', 'stepColor', 'moveToColorTemperature', 'moveColorTemperature', 'stepColorTemperature'],
    Identify:       ['identify', 'triggerEffect'],
    Groups:         ['addGroup', 'viewGroup', 'getGroupMembership', 'removeGroup', 'removeAllGroups', 'addGroupIfIdentifying'],
    Thermostat:     ['setpointRaiseLower', 'setWeeklySchedule', 'getWeeklySchedule', 'clearWeeklySchedule'],
    DoorLock:       ['lockDoor', 'unlockDoor', 'unlockWithTimeout'],
    WindowCovering: ['upOrOpen', 'downOrClose', 'stopMotion', 'goToLiftValue', 'goToLiftPercentage', 'goToTiltValue', 'goToTiltPercentage'],
    FanControl:     [],
};

// ── Cache ─────────────────────────────────────────────────────────────────────
let mqttTopics: string[] = [];
let dbDocIds: string[] = [];
let dbViewIds: string[] = [];
// nodeId → detail (with endpoints/clusters)
const matterCache = new Map<string, MatterNodeDetail>();
let matterNodeIds: string[] = [];

async function refreshMqtt() {
    try {
        const data = await fetchMqttState();
        mqttTopics = data.map(e => e.topic);
    } catch { /* ignore */ }
}

async function refreshDb() {
    try {
        const [docs, views] = await Promise.all([listDocs(), listViews()]);
        dbDocIds = docs;
        dbViewIds = views;
    } catch { /* ignore */ }
}

async function refreshMatter() {
    try {
        const devices = await listMatterDevices();
        matterNodeIds = devices.map(d => d.nodeId);
        // Preload details for all nodes
        await Promise.all(
            devices.map(async (d) => {
                if (!matterCache.has(d.nodeId)) {
                    try {
                        matterCache.set(d.nodeId, await getMatterDevice(d.nodeId));
                    } catch { /* ignore */ }
                }
            }),
        );
    } catch { /* ignore */ }
}

// ── Context detection ─────────────────────────────────────────────────────────
type CompletionCtx =
    | { type: 'mqtt'; prefix: string }
    | { type: 'db'; prefix: string; includeViews: boolean }
    | { type: 'matter-nodeId'; prefix: string }
    | { type: 'matter-endpointId'; nodeId: string }
    | { type: 'matter-cluster'; nodeId: string; endpointId: number }
    | { type: 'matter-attr'; nodeId: string; endpointId: number; cluster: string; isSend: boolean }
    | null;

/**
 * Parse the text on the current line up to the cursor and determine what
 * kind of value completion is appropriate.
 */
function detectContext(lineUpToCursor: string): CompletionCtx {
    // ── MQTT ──────────────────────────────────────────────────────────────────
    // she.mqtt.(sub|pub|get|set|link|age|getProp|set)( '...'
    // Also top-level helpers: she.link, she.age, she.getValue, she.setValue
    const mqttRe =
        /(?:she\.mqtt\.(?:sub|pub|get|set|link|age|getProp)|she\.(?:link|age|getValue|setValue|getProp|combineBool|combineMax|timer))\s*\([^)]*?['"]([^'"]*)\s*$/;
    const mqttM = lineUpToCursor.match(mqttRe);
    if (mqttM) return { type: 'mqtt', prefix: mqttM[1] };

    // ── sheDB ─────────────────────────────────────────────────────────────────
    // she.db.(get|set|extend|delete|sub|prop|query)( '...'
    // sub/query accept wildcard patterns → also offer views for sub
    const dbSubRe = /she\.db\.sub\s*\([^)]*?['"]([^'"]*)\s*$/;
    const dbSubM = lineUpToCursor.match(dbSubRe);
    if (dbSubM) return { type: 'db', prefix: dbSubM[1], includeViews: true };

    const dbRe = /she\.db\.(?:get|set|extend|delete|prop|query)\s*\([^)]*?['"]([^'"]*)\s*$/;
    const dbM = lineUpToCursor.match(dbRe);
    if (dbM) return { type: 'db', prefix: dbM[1], includeViews: false };

    // ── Matter ────────────────────────────────────────────────────────────────
    // she.matter.(sub|get|send|on|unsub)( ... up to 4 positional string/number args
    const matterCallRe = /she\.matter\.(?:sub|get|send|on)\s*\(\s*(.*)\s*$/;
    const matterCallM = lineUpToCursor.match(matterCallRe);
    if (matterCallM) {
        const argsText = matterCallM[1];
        // Count completed arguments (number of top-level commas)
        const argIdx = countArgs(argsText);
        // Extract the string prefix being typed for the current arg
        const curArgPrefix = currentArgPrefix(argsText);

        if (argIdx === 0) {
            // First arg: nodeId
            return { type: 'matter-nodeId', prefix: curArgPrefix };
        }
        if (argIdx === 1) {
            // Second arg: endpointId (number) — extract nodeId from first arg
            const nodeId = extractStringArg(argsText, 0);
            if (nodeId) return { type: 'matter-endpointId', nodeId };
        }
        if (argIdx === 2) {
            // Third arg: clusterName
            const nodeId = extractStringArg(argsText, 0);
            const epStr = extractNumberArg(argsText, 1);
            if (nodeId && epStr !== null) {
                return { type: 'matter-cluster', nodeId, endpointId: epStr };
            }
        }
        if (argIdx >= 3) {
            // Fourth arg: attr name (get/sub) or command name (send)
            const nodeId = extractStringArg(argsText, 0);
            const epId = extractNumberArg(argsText, 1);
            const cluster = extractStringArg(argsText, 2);
            const isSend = /she\.matter\.send\s*\(/.test(lineUpToCursor);
            if (nodeId && epId !== null && cluster) {
                return { type: 'matter-attr', nodeId, endpointId: epId, cluster, isSend };
            }
        }
    }

    return null;
}

/** Count completed arguments (commas at depth 0) in an argument list string. */
function countArgs(argsText: string): number {
    let depth = 0;
    let commas = 0;
    let inStr = false;
    let strChar = '';
    for (const ch of argsText) {
        if (inStr) { if (ch === strChar) inStr = false; continue; }
        if (ch === '"' || ch === "'") { inStr = true; strChar = ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; continue; }
        if (ch === ',' && depth === 0) commas++;
    }
    return commas;
}

/** Get the prefix of the string being typed in the current (last) argument. */
function currentArgPrefix(argsText: string): string {
    // Find last unmatched quote
    const m = argsText.match(/['"]([^'"]*)\s*$/);
    return m ? m[1] : '';
}

/** Extract the string value of the nth argument (0-indexed). */
function extractStringArg(argsText: string, n: number): string | null {
    const args = splitArgs(argsText);
    const arg = args[n]?.trim();
    if (!arg) return null;
    const m = arg.match(/^['"](.*)['"]$/);
    return m ? m[1] : null;
}

/** Extract the number value of the nth argument as a number. */
function extractNumberArg(argsText: string, n: number): number | null {
    const args = splitArgs(argsText);
    const arg = args[n]?.trim();
    if (!arg) return null;
    const v = parseInt(arg, 10);
    return isNaN(v) ? null : v;
}

/** Split an argument list string on top-level commas. */
function splitArgs(argsText: string): string[] {
    const result: string[] = [];
    let current = '';
    let depth = 0;
    let inStr = false;
    let strChar = '';
    for (const ch of argsText) {
        if (inStr) { if (ch === strChar) inStr = false; current += ch; continue; }
        if (ch === '"' || ch === "'") { inStr = true; strChar = ch; current += ch; continue; }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; current += ch; continue; }
        if (ch === ')' || ch === ']' || ch === '}') { depth--; current += ch; continue; }
        if (ch === ',' && depth === 0) { result.push(current); current = ''; continue; }
        current += ch;
    }
    result.push(current);
    return result;
}

// ── Completion item builders ──────────────────────────────────────────────────
const CK = monaco.languages.CompletionItemKind;

function topicItems(
    range: monaco.IRange,
    prefix: string,
): monaco.languages.CompletionItem[] {
    const filtered = prefix
        ? mqttTopics.filter(t => t.startsWith(prefix))
        : mqttTopics;
    return filtered.map((t) => ({
        label: t,
        kind: CK.Value,
        insertText: t,
        range,
        detail: 'MQTT topic',
        sortText: '0' + t,
    }));
}

function dbItems(
    range: monaco.IRange,
    prefix: string,
    includeViews: boolean,
): monaco.languages.CompletionItem[] {
    const ids = includeViews ? [...dbDocIds, ...dbViewIds] : dbDocIds;
    const filtered = prefix ? ids.filter(id => id.startsWith(prefix)) : ids;
    return filtered.map((id) => ({
        label: id,
        kind: CK.Value,
        insertText: id,
        range,
        detail: dbViewIds.includes(id) ? 'sheDB view' : 'sheDB document',
        sortText: '0' + id,
    }));
}

function nodeIdItems(range: monaco.IRange, prefix: string): monaco.languages.CompletionItem[] {
    return matterNodeIds
        .filter(id => id.startsWith(prefix))
        .map(id => ({
            label: id,
            kind: CK.Value,
            insertText: id,
            range,
            detail: 'Matter node',
            sortText: '0' + id,
        }));
}

function endpointIdItems(range: monaco.IRange, nodeId: string): monaco.languages.CompletionItem[] {
    const detail = matterCache.get(nodeId);
    if (!detail) return [];
    return detail.endpoints.map(ep => ({
        label: String(ep.endpointId),
        kind: CK.Value,
        insertText: String(ep.endpointId),
        range,
        detail: `Endpoint — clusters: ${ep.clusters.join(', ')}`,
        sortText: '0' + String(ep.endpointId).padStart(4, '0'),
    }));
}

function clusterItems(
    range: monaco.IRange,
    nodeId: string,
    endpointId: number,
): monaco.languages.CompletionItem[] {
    const detail = matterCache.get(nodeId);
    if (!detail) return [];
    const ep = detail.endpoints.find(e => e.endpointId === endpointId);
    if (!ep) return [];
    return ep.clusters.map(c => ({
        label: c,
        kind: CK.Value,
        insertText: c,
        range,
        detail: 'Matter cluster',
        sortText: '0' + c,
    }));
}

function attrItems(
    range: monaco.IRange,
    cluster: string,
    isSend: boolean,
): monaco.languages.CompletionItem[] {
    const names = isSend ? (CLUSTER_CMDS[cluster] ?? []) : (CLUSTER_ATTRS[cluster] ?? []);
    return names.map(n => ({
        label: n,
        kind: isSend ? CK.Function : CK.Property,
        insertText: n,
        range,
        detail: isSend ? `${cluster} command` : `${cluster} attribute`,
        sortText: '0' + n,
    }));
}

// ── Public init ───────────────────────────────────────────────────────────────
export function registerCompletionProviders(): void {
    // Initial fetch
    void refreshMqtt();
    void refreshDb();
    void refreshMatter();

    // Periodic refresh
    setInterval(refreshMqtt, 15_000);
    setInterval(refreshDb, 10_000);
    setInterval(refreshMatter, 60_000);

    monaco.languages.registerCompletionItemProvider('javascript', {
        triggerCharacters: ["'", '"', '(', ',', ' '],

        provideCompletionItems(
            model: monaco.editor.ITextModel,
            position: monaco.Position,
        ): monaco.languages.CompletionList | null {
            const lineUpToCursor = model.getValueInRange({
                startLineNumber: position.lineNumber,
                startColumn: 1,
                endLineNumber: position.lineNumber,
                endColumn: position.column,
            });

            const ctx = detectContext(lineUpToCursor);
            if (!ctx) return null;

            // Determine the replacement range: from after the last quote to cursor
            const wordInfo = model.getWordUntilPosition(position);
            // For string completions, find the opening quote and replace from there
            const lastQuote = Math.max(lineUpToCursor.lastIndexOf("'"), lineUpToCursor.lastIndexOf('"'));
            const startCol = lastQuote >= 0 ? lastQuote + 2 : wordInfo.startColumn;

            const range: monaco.IRange = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: startCol,
                endColumn: position.column,
            };

            switch (ctx.type) {
                case 'mqtt':
                    return { suggestions: topicItems(range, ctx.prefix) };

                case 'db':
                    return { suggestions: dbItems(range, ctx.prefix, ctx.includeViews) };

                case 'matter-nodeId':
                    return { suggestions: nodeIdItems(range, ctx.prefix) };

                case 'matter-endpointId':
                    return { suggestions: endpointIdItems(range, ctx.nodeId) };

                case 'matter-cluster':
                    return { suggestions: clusterItems(range, ctx.nodeId, ctx.endpointId) };

                case 'matter-attr':
                    return { suggestions: attrItems(range, ctx.cluster, ctx.isSend) };

                default:
                    return null;
            }
        },
    });
}
