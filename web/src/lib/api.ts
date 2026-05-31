/** Auth token — set once on startup from localStorage. */
let _token = localStorage.getItem('she_token') ?? '';

export function setToken(t: string) {
    _token = t;
    localStorage.setItem('she_token', t);
}

export function getToken() {
    return _token;
}

function headers(extra: Record<string, string> = {}) {
    const h: Record<string, string> = { 'Content-Type': 'application/json', ...extra };
    if (_token) h['Authorization'] = `Bearer ${_token}`;
    return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
    }
    return res.json();
}

// ---- Scripts API ----

export interface ScriptEntry {
    path: string;
    size: number;
    mtime: number;
}

export function listScripts(): Promise<ScriptEntry[]> {
    return request('GET', '/she/scripts');
}

export function readScript(path: string): Promise<{ path: string; content: string }> {
    return request('GET', `/she/scripts/${path}`);
}

export function writeScript(path: string, content: string): Promise<{ ok: boolean }> {
    return request('PUT', `/she/scripts/${path}`, { content });
}

export function deleteScript(path: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/scripts/${path}`);
}

export function renameScript(path: string, newPath: string): Promise<{ ok: boolean }> {
    return request('POST', `/she/scripts/${path}/rename`, { newPath });
}

// ---- Config API ----

export function getConfig(): Promise<Record<string, unknown>> {
    return request('GET', '/she/config');
}

export function putConfig(cfg: Record<string, unknown>): Promise<{ ok: boolean; restartRequired: boolean }> {
    return request('PUT', '/she/config', cfg);
}

// ---- sheDB API ----

export interface ViewDefinition {
    filter?: string;
    map: string;
    reduce?: string;
}

export interface ViewResult {
    _id: string;
    _rev: number;
    result?: unknown[];
    length?: number;
    error?: string;
}

export function listDocs(): Promise<string[]> {
    return request('GET', '/she/db/docs');
}

export function getDoc(id: string): Promise<Record<string, unknown>> {
    return request('GET', `/she/db/docs/${id}`);
}

export function putDoc(id: string, doc: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request('PUT', `/she/db/docs/${id}`, doc);
}

export function patchDoc(id: string, partial: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request('PATCH', `/she/db/docs/${id}`, partial);
}

export function deleteDoc(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/db/docs/${id}`);
}

export function listViews(): Promise<string[]> {
    return request('GET', '/she/db/views');
}

export function getView(id: string): Promise<ViewDefinition> {
    return request('GET', `/she/db/views/${id}`);
}

export function putView(id: string, view: ViewDefinition): Promise<{ ok: boolean }> {
    return request('PUT', `/she/db/views/${id}`, view);
}

export function deleteView(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/db/views/${id}`);
}

export function getViewResult(id: string): Promise<ViewResult> {
    return request('GET', `/she/db/views/${id}/result`);
}

// ---- Matter API ----

export interface MatterDevice {
    nodeId: string;
    online: boolean;
}

export interface MatterEndpoint {
    endpointId: number;
    clusters: string[];
}

export interface MatterNodeDetail {
    nodeId: string;
    endpoints: MatterEndpoint[];
}

export function listMatterDevices(): Promise<MatterDevice[]> {
    return request('GET', '/she/matter/devices');
}

export function getMatterDevice(nodeId: string): Promise<MatterNodeDetail> {
    return request('GET', `/she/matter/devices/${nodeId}`);
}

export function commissionMatter(opts: { passcode: number; discriminator?: number } | { pairingCode: string }): Promise<{ nodeId: string }> {
    return request('POST', '/she/matter/commission', opts);
}

export function unpairMatter(nodeId: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/matter/devices/${nodeId}`);
}

export function sendMatterCommand(
    nodeId: string,
    endpointId: number,
    clusterName: string,
    command: string,
    args?: Record<string, unknown>,
): Promise<{ ok: boolean; result: unknown }> {
    return request('POST', `/she/matter/devices/${nodeId}/command`, { endpointId, clusterName, command, args });
}

// ---- MQTT API ----

export interface MqttEntry {
    topic: string;
    val: unknown;
    ts: number;
}

export function fetchMqttState(): Promise<MqttEntry[]> {
    return request('GET', '/she/mqtt/state');
}

export function publishMqtt(
    topic: string,
    payload: string,
    retain = false,
    qos: 0 | 1 | 2 = 0,
): Promise<{ ok: boolean }> {
    return request('POST', '/she/mqtt/publish', { topic, payload, retain, qos });
}
