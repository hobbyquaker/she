/** Called when any /she/* request returns 401 — App.svelte wires this to show the login overlay. */
let _onUnauthorized: (() => void) | null = null;
export function onUnauthorized(cb: () => void) {
    _onUnauthorized = cb;
}

function headers(extra: Record<string, string> = {}) {
    return { 'Content-Type': 'application/json', ...extra };
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(path, {
        method,
        headers: headers(),
        body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
        if (_onUnauthorized) _onUnauthorized();
        throw new Error('Unauthorized');
    }
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? res.statusText);
    }
    return res.json();
}

// ---- Auth API ----

export type AuthMode = 'none' | 'password' | 'proxy';

export interface AuthModeResponse {
    mode: AuthMode;
    proxyLogoutUrl?: string;
}

export async function getAuthMode(): Promise<AuthModeResponse> {
    const res = await fetch('/she/auth/mode');
    const data = await res.json();
    return data as AuthModeResponse;
}

export async function login(password: string): Promise<void> {
    const res = await fetch('/she/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? 'Login failed');
    }
}

export async function logout(): Promise<void> {
    await fetch('/she/auth/logout', { method: 'POST' });
}

export async function setupAuth(mode: AuthMode, password?: string, proxyHeader?: string, proxyLogoutUrl?: string): Promise<void> {
    const res = await fetch('/she/auth/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, password, proxyHeader, proxyLogoutUrl }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(err.error ?? 'Setup failed');
    }
}

// ---- Scripts API ----

export interface ScriptEntry {
    path: string;
    size: number;
    mtime: number;
    lib?: boolean;
}

export interface TreeEntry {
    type: 'file' | 'dir';
    name: string;
    path: string;
    lib: boolean;
    disabled?: boolean;
    size?: number;
    mtime?: number;
    children?: TreeEntry[];
}

export function listScripts(): Promise<ScriptEntry[]> {
    return request('GET', '/she/scripts');
}

export function listScriptsTree(): Promise<TreeEntry[]> {
    return request('GET', '/she/scripts/tree');
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

export function createScriptDir(dirPath: string): Promise<{ ok: boolean; path: string }> {
    return request('POST', '/she/scripts/mkdir', { path: dirPath });
}

// ---- Git API ----

export interface GitChange {
    status: string;
    file: string;
}

export interface GitStatus {
    branch: string;
    changes: GitChange[];
    ahead: number;
    behind: number;
}

export interface GitRemote {
    name: string;
    fetch: string;
    push: string;
}

export function gitStatus(): Promise<GitStatus> {
    return request('GET', '/she/git/status');
}

// ---- Daemon status + restart ----

export interface DaemonStatus {
    scripts: number;
    topics: number;
    mqttMsgPerSec?: number;
    matterEnabled?: boolean;
    matterNodes?: number;
    matterEndpoints?: number;
    dbEnabled?: boolean;
    dbDocs?: number | null;
    dbViews?: number | null;
    handlers?: number;
    memMb?: number;
    cpuPercent?: number;
    latestVersion?: string;
}

export function getDaemonStatus(): Promise<DaemonStatus> {
    return request('GET', '/she/status');
}

export function restartDaemon(): Promise<{ ok: boolean }> {
    return request('POST', '/she/restart');
}

export function updateDaemon(): Promise<{ ok: boolean }> {
    return request('POST', '/she/update');
}

export function checkForUpdate(): Promise<{ latestVersion: string | null }> {
    return request('POST', '/she/check-update');
}

export function gitRemotes(): Promise<GitRemote[]> {
    return request('GET', '/she/git/remotes');
}

export function commitFile(filePath: string, message: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/git/commit', { path: filePath, message });
}

export function commitFiles(files: string[], message: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/git/commit', { files, message });
}

export function gitPush(remote?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/git/push', { remote });
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
    mqttpub?: boolean;
    retain?: boolean;
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

// ---- Deps API ----

export interface DepEntry {
    name: string;
    version: string;
    url?: string;
}

export interface NpmSearchResult {
    name: string;
    version: string;
    description: string;
    url?: string;
}

export function listDeps(): Promise<DepEntry[]> {
    return request('GET', '/she/deps');
}

export function searchNpm(q: string): Promise<NpmSearchResult[]> {
    return request('GET', `/she/deps/search?q=${encodeURIComponent(q)}`);
}

export function installDep(name: string, version?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/deps/install', { name, version: version ?? null });
}

export function removeDep(name: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/deps/remove', { name });
}

export function updateDep(name: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/deps/update', { name });
}

export function getViewResult(id: string): Promise<ViewResult> {
    return request('GET', `/she/db/views/${id}/result`);
}

// ---- Matter API ----

export interface MatterDevice {
    nodeId: string;
    online: boolean;
    name?: string | null;
}

export interface MatterCluster {
    name: string;
    attrs: Record<string, unknown>;
}

export interface MatterEndpoint {
    endpointId: number;
    clusters: MatterCluster[];
    name?: string | null;
}

export interface MatterNodeDetail {
    nodeId: string;
    name?: string | null;
    subtitle?: string | null;
    endpoints: MatterEndpoint[];
}

export function listMatterDevices(): Promise<MatterDevice[]> {
    return request('GET', '/she/matter/devices');
}

export function getMatterDevice(nodeId: string): Promise<MatterNodeDetail> {
    return request('GET', `/she/matter/devices/${nodeId}`);
}

export function commissionMatter(opts: ({ passcode: number; discriminator?: number } | { pairingCode: string }) & { discoveryAddress?: string }): Promise<{ nodeId: string }> {
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

export function publishMqtt(topic: string, payload: string, retain = false, qos: 0 | 1 | 2 = 0): Promise<{ ok: boolean }> {
    return request('POST', '/she/mqtt/publish', { topic, payload, retain, qos });
}

// ---- AI Assistant API ----

export interface AiMessage {
    role: 'user' | 'assistant';
    content: string;
    toolEvents?: AiToolEvent[];
}

export interface AiToolEvent {
    type: 'tool_call' | 'tool_result';
    name: string;
    args?: Record<string, unknown>;
    content?: string;
}

export interface AiContext {
    apiref: boolean;
    mqtt?: boolean;
    shedb?: boolean;
    matter?: boolean;
    sampleDocs?: boolean;
    tools?: boolean;
}

export interface AiCurrentScript {
    path: string;
    content: string;
}

export interface AiCurrentView {
    id: string;
    filter: string;
    map: string;
    reduce: string;
}

export interface AiExtraFile {
    name: string;
    content: string;
}

export interface AiChatRequest {
    messages: AiMessage[];
    currentScript?: AiCurrentScript | null;
    currentView?: AiCurrentView | null;
    context: AiContext;
    modelOverride?: string;
    extraFiles?: AiExtraFile[];
}

export interface AiChatResponse {
    message: string;
    usage?: { prompt_tokens: number; completion_tokens: number };
}

export interface AiConfig {
    configured: boolean;
    provider: string;
    model: string;
    baseUrl: string;
}

export interface OllamaModelDetails {
    family?: string;
    families?: string[];
    format?: string;
    parameter_size?: string;
    quantization_level?: string;
}

export interface OllamaRunningModel {
    name: string;
    size: number;
    size_vram: number;
    expires_at: string;
}

export interface OllamaModelInfo {
    version: string | null;
    details: OllamaModelDetails | null;
    running: OllamaRunningModel[] | null;
}

export function getAiConfig(): Promise<AiConfig> {
    return request('GET', '/she/ai/config');
}

export function getAiModels(): Promise<{ models: string[] }> {
    return request('GET', '/she/ai/models');
}

export function getOllamaModelInfo(model: string): Promise<OllamaModelInfo> {
    return request('GET', `/she/ai/model-info?model=${encodeURIComponent(model)}`);
}

export function chatWithAI(body: AiChatRequest): Promise<AiChatResponse> {
    return request('POST', '/she/ai/chat', body);
}

export function getAiPrompt(body: {
    context?: Partial<AiContext>;
    currentScript?: AiCurrentScript | null;
    currentView?: AiCurrentView | null;
    extraFiles?: AiExtraFile[];
}): Promise<{ prompt: string }> {
    return request('POST', '/she/ai/prompt', body);
}

/**
 * Stream a chat response via SSE.
 * onToken is called for each text token; the returned promise resolves when done.
 * Pass an AbortSignal to support cancellation.
 */
export async function streamChatWithAI(body: AiChatRequest, onToken: (token: string) => void, signal?: AbortSignal, onEvent?: (event: AiToolEvent) => void): Promise<void> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };

    const res = await fetch('/she/ai/chat/stream', {
        method: 'POST',
        headers: h,
        body: JSON.stringify(body),
        signal,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error((err as { error?: string }).error ?? res.statusText);
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (data === '[DONE]') return;
                try {
                    const json = JSON.parse(data) as { token?: string; error?: string; type?: string; name?: string; args?: Record<string, unknown>; content?: string };
                    if (json.error) throw new Error(json.error);
                    if (json.type === 'tool_call' || json.type === 'tool_result') {
                        onEvent?.({ type: json.type, name: json.name ?? '', args: json.args, content: json.content });
                        continue;
                    }
                    if (json.token) onToken(json.token);
                } catch (e) {
                    // re-throw real errors; skip malformed JSON
                    if (e instanceof SyntaxError) continue;
                    throw e;
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
