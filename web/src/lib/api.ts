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

export interface SearchMatch {
    line: number;
    col: number;
    preview: string;
}
export interface SearchResult {
    path: string;
    matches: SearchMatch[];
}

export function searchScripts(
    q: string,
    opts: { regex?: boolean; caseSensitive?: boolean; mode?: 'text' | 'files' } = {},
): Promise<{ results: SearchResult[] | string[]; truncated: boolean }> {
    const params = new URLSearchParams({ q });
    if (opts.regex) params.set('regex', 'true');
    if (opts.caseSensitive) params.set('caseSensitive', 'true');
    if (opts.mode) params.set('mode', opts.mode);
    return request('GET', `/she/scripts/search?${params}`);
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
    runningScripts?: string[];
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
    eluPercent?: number;
    elMeanMs?: number;
    elMaxMs?: number;
    latestVersion?: string;
    dataDir?: string;
    startedAt?: number;
    docker?: boolean;
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

/** Stage the entire script directory and commit. */
export function commitAll(message: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/git/commit', { message });
}

export function gitPush(remote?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/git/push', { remote });
}

export interface GitCommit {
    hash: string;
    subject: string;
    author: string;
    date: string;
}

export function getGitLog(filePath: string, limit: number): Promise<GitCommit[]> {
    return request('GET', `/she/git/log?path=${encodeURIComponent(filePath)}&limit=${limit}`);
}

export function getGitFileAtCommit(hash: string, filePath: string): Promise<{ content: string | null; binary: boolean }> {
    return request('GET', `/she/git/show?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(filePath)}`);
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
    description?: string;
}

export interface ViewResult {
    _id: string;
    _rev: number;
    result?: unknown[];
    length?: number;
    error?: string;
}

/** Encode a sheDB document/view ID for use in a URL path. Slashes are preserved as path separators. */
function encodeDbId(id: string): string {
    return id.split('/').map(encodeURIComponent).join('/');
}

export function listDocs(): Promise<string[]> {
    return request('GET', '/she/db/docs');
}

export function getDoc(id: string): Promise<Record<string, unknown>> {
    return request('GET', `/she/db/docs/${encodeDbId(id)}`);
}

export function putDoc(id: string, doc: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request('PUT', `/she/db/docs/${encodeDbId(id)}`, doc);
}

export function patchDoc(id: string, partial: Record<string, unknown>): Promise<{ ok: boolean }> {
    return request('PATCH', `/she/db/docs/${encodeDbId(id)}`, partial);
}

export function deleteDoc(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/db/docs/${encodeDbId(id)}`);
}

export function listViews(): Promise<string[]> {
    return request('GET', '/she/db/views');
}

export function getView(id: string): Promise<ViewDefinition> {
    return request('GET', `/she/db/views/${encodeDbId(id)}`);
}

export function putView(id: string, view: ViewDefinition): Promise<{ ok: boolean }> {
    return request('PUT', `/she/db/views/${encodeDbId(id)}`, view);
}

export function deleteView(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/db/views/${encodeDbId(id)}`);
}

// ---- Deps API ----

export interface DepEntry {
    name: string;
    version: string; // specifier from package.json (e.g. "^1.0.0")
    installedVersion?: string; // actual version in node_modules
    url?: string;
}

export interface DepOutdatedEntry {
    current: string;
    latest: string;
}

export interface NpmSearchResult {
    name: string;
    version: string;
    description: string;
    url?: string;
    author?: string;
    date?: string;
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

export function getOutdatedDeps(): Promise<Record<string, DepOutdatedEntry>> {
    return request('GET', '/she/deps/outdated');
}

export function checkOutdatedDeps(): Promise<Record<string, DepOutdatedEntry>> {
    return request('POST', '/she/deps/check-outdated');
}

// ---- AI Conversations API ----

export interface AiConversation {
    id: string;
    title: string;
    updatedAt: number;
    messages: AiMessage[];
}

export function listConversations(): Promise<AiConversation[]> {
    return request('GET', '/she/ai/conversations');
}

export function getConversation(id: string): Promise<AiConversation> {
    return request('GET', `/she/ai/conversations/${encodeURIComponent(id)}`);
}

export function saveConversation(id: string, title: string, messages: AiMessage[]): Promise<{ ok: boolean }> {
    return request('PUT', `/she/ai/conversations/${encodeURIComponent(id)}`, { title, messages });
}

export function deleteConversation(id: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/ai/conversations/${encodeURIComponent(id)}`);
}

export function getViewResult(id: string): Promise<ViewResult> {
    return request('GET', `/she/db/views/${encodeDbId(id)}/result`);
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
    contextLength: number | null;
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

// ---- Broker API ----

export interface BrokerDynsecStatus {
    connected: boolean;
    configured: boolean;
    dynsecReady: boolean;
}

export interface BrokerStatus {
    dynsec: BrokerDynsecStatus;
    sys: Record<string, { val: unknown; ts: number }>;
    sshKeyDefault: string;
    sshConfigured: boolean;
    sshHost: string | null;
}

export interface BrokerListenerTls {
    enabled?: boolean; // UI-only flag; not written to mosquitto.conf
    certfile?: string;
    keyfile?: string;
    cafile?: string;
    capath?: string;
    crlfile?: string;
    tls_version?: string;
    require_certificate?: boolean;
    use_identity_as_username?: boolean;
    use_subject_as_username?: boolean;
}

export interface BrokerListener {
    port: number;
    bindAddress?: string;
    protocol?: string;
    mount_point?: string;
    max_connections?: number;
    max_qos?: number;
    tls: BrokerListenerTls;
    allow_anonymous?: boolean;
    password_file?: string;
    acl_file?: string;
}

export interface BrokerConf {
    listeners: BrokerListener[];
    managed: Record<string, string | string[]>;
    passthrough: string[];
    raw?: string;
    checksum: string | null;
    backups: string[];
}

export interface DynsecAcl {
    acltype: string;
    topic: string;
    allow: boolean;
    priority?: number;
}

export interface DynsecRole {
    rolename: string;
    acls?: DynsecAcl[];
}

export interface DynsecUser {
    username: string;
    roles?: { rolename: string }[];
    groups?: { groupname: string }[];
}

export interface DynsecGroup {
    groupname: string;
    roles?: { rolename: string }[];
    clients?: { username: string }[];
}

export function getBrokerStatus(): Promise<BrokerStatus> {
    return request('GET', '/she/broker/status');
}

export interface BrokerLocalCheck {
    mosquittoCtrl: boolean;
    mosquitto: boolean;
}

export function getBrokerLocalCheck(): Promise<BrokerLocalCheck> {
    return request('GET', '/she/broker/local/check');
}

export function getBrokerIpAddresses(): Promise<{ addresses: string[] }> {
    return request('GET', '/she/broker/ip-addresses');
}

export function getBrokerConf(): Promise<BrokerConf> {
    return request('GET', '/she/broker/config');
}

export function getBrokerLogs(limit = 500): Promise<{ level: string; msg: string; ts: number }[]> {
    return request('GET', `/she/broker/logs?limit=${limit}`);
}

export function putBrokerConf(conf: Pick<BrokerConf, 'listeners' | 'managed' | 'passthrough'> & { checksum?: string | null }): Promise<{ ok: boolean; backupPath: string | null }> {
    return request('PUT', '/she/broker/config', conf);
}

export function putBrokerConfRaw(content: string, checksum?: string | null): Promise<{ ok: boolean; backupPath: string | null }> {
    return request('PUT', '/she/broker/config/raw', { content, checksum });
}

export function getBrokerBackups(): Promise<{ backups: string[] }> {
    return request('GET', '/she/broker/config/backups');
}

export function restoreBrokerBackup(backup: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/config/restore', { backup });
}

export function brokerReload(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/broker/reload');
}

export function brokerRestart(): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return request('POST', '/she/broker/restart');
}

export function brokerDynsecDeactivate(): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/wizard/deactivate');
}

export function brokerDynsecReinit(): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/wizard/reinit');
}

export interface DynsecDiagnosis {
    ok: boolean;
    dynSecPath: string;
    adminUsername?: string;
    adminClientExists?: boolean;
    adminRoles?: string[];
    hasAdminRole?: boolean;
    hasControlSendAcl?: boolean;
    clientCount?: number;
    roleCount?: number;
    issues: string[];
    error?: string;
}

export function brokerDynsecDiagnose(): Promise<DynsecDiagnosis> {
    return request('GET', '/she/broker/wizard/diagnose');
}

// passwd file management
export function listPasswdUsers(file: string): Promise<{ users: string[] }> {
    return request('GET', `/she/broker/passwd?file=${encodeURIComponent(file)}`);
}

export function addPasswdUser(file: string, username: string, password: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/passwd', { file, username, password });
}

export function deletePasswdUser(file: string, username: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/passwd/${encodeURIComponent(username)}`, { file });
}

// ACL file management
export function readAclFile(file: string): Promise<{ content: string }> {
    return request('GET', `/she/broker/acl?file=${encodeURIComponent(file)}`);
}

export function writeAclFile(file: string, content: string): Promise<{ ok: boolean }> {
    return request('PUT', '/she/broker/acl', { file, content });
}

// dynsec — users
export function listBrokerUsers(): Promise<{ users: DynsecUser[] }> {
    return request('GET', '/she/broker/users');
}

export function createBrokerUser(username: string, password: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/users', { username, password });
}

export function deleteBrokerUser(username: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/users/${encodeURIComponent(username)}`);
}

export function setBrokerUserPassword(username: string, password: string): Promise<{ ok: boolean }> {
    return request('PUT', `/she/broker/users/${encodeURIComponent(username)}/password`, { password });
}

export function assignBrokerUserRole(username: string, rolename: string): Promise<{ ok: boolean }> {
    return request('POST', `/she/broker/users/${encodeURIComponent(username)}/roles`, { rolename });
}

export function removeBrokerUserRole(username: string, rolename: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/users/${encodeURIComponent(username)}/roles/${encodeURIComponent(rolename)}`);
}

// dynsec — roles
export function listBrokerRoles(): Promise<{ roles: DynsecRole[] }> {
    return request('GET', '/she/broker/roles');
}

export function createBrokerRole(rolename: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/roles', { rolename });
}

export function deleteBrokerRole(rolename: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/roles/${encodeURIComponent(rolename)}`);
}

export function addBrokerRoleAcl(rolename: string, acl: { acltype: string; topic: string; allow: boolean; priority?: number }): Promise<{ ok: boolean }> {
    return request('POST', `/she/broker/roles/${encodeURIComponent(rolename)}/acls`, acl);
}

export function removeBrokerRoleAcl(rolename: string, acltype: string, topic: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/roles/${encodeURIComponent(rolename)}/acls`, { acltype, topic });
}

// dynsec — groups
export function listBrokerGroups(): Promise<{ groups: DynsecGroup[] }> {
    return request('GET', '/she/broker/groups');
}

export function createBrokerGroup(groupname: string): Promise<{ ok: boolean }> {
    return request('POST', '/she/broker/groups', { groupname });
}

export function deleteBrokerGroup(groupname: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/groups/${encodeURIComponent(groupname)}`);
}

export function addBrokerGroupClient(groupname: string, username: string): Promise<{ ok: boolean }> {
    return request('POST', `/she/broker/groups/${encodeURIComponent(groupname)}/clients`, { username });
}

export function removeBrokerGroupClient(groupname: string, username: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/groups/${encodeURIComponent(groupname)}/clients/${encodeURIComponent(username)}`);
}

export function addBrokerGroupRole(groupname: string, rolename: string): Promise<{ ok: boolean }> {
    return request('POST', `/she/broker/groups/${encodeURIComponent(groupname)}/roles`, { rolename });
}

export function removeBrokerGroupRole(groupname: string, rolename: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/groups/${encodeURIComponent(groupname)}/roles/${encodeURIComponent(rolename)}`);
}

// dynsec — default ACL access
export interface DefaultAclEntry {
    acltype: string;
    allow: boolean;
}

export function getDefaultAclAccess(): Promise<{ acls: DefaultAclEntry[] }> {
    return request('GET', '/she/broker/acl-defaults');
}

export function setDefaultAclAccess(acls: DefaultAclEntry[]): Promise<{ ok: boolean }> {
    return request('PUT', '/she/broker/acl-defaults', { acls });
}

// dynsec — ACL topic inspection
export interface AclCheckRole {
    rolename: string;
    allow: boolean;
    dynamic: boolean;
    users: string[];
    groups: Array<{ groupname: string; members: string[] }>;
}
export interface AclCheckSection {
    roles: AclCheckRole[];
    default: boolean;
}
export interface AclCheckResult {
    topic: string;
    send: AclCheckSection;
    subscribe: AclCheckSection;
    receive: AclCheckSection;
}
export function checkBrokerAcl(topic: string): Promise<AclCheckResult> {
    return request('GET', `/she/broker/acl-check?${new URLSearchParams({ topic })}`);
}

// dynsec — anonymous group
export function getAnonymousGroup(): Promise<{ group: string | null }> {
    return request('GET', '/she/broker/anonymous-group');
}

export function setAnonymousGroup(groupname: string | null): Promise<{ ok: boolean }> {
    return request('PUT', '/she/broker/anonymous-group', { groupname });
}

// broker — CA
export interface CaInfo {
    crt: string;
    fingerprint: string;
    expires: string;
    cn: string;
    hasChain?: boolean;
    chainCn?: string | null;
}

export function importBrokerCA(
    body: { cert: string; key: string; chain?: string } | { p12base64: string; passphrase: string; chain?: string },
): Promise<{ ok: boolean; ca: CaInfo }> {
    return request('POST', '/she/broker/ca/import', body);
}

export interface ServerCertInfo {
    fingerprint: string;
    expires: string;
    cn: string;
}

export interface TrustedCert {
    filename: string;
    cn: string;
    fingerprint: string;
    expires: string;
}

export interface IssuedCert {
    _id?: string;
    cn: string;
    serial: string;
    fingerprint: string;
    issued: string;
    expires: string;
    revoked: boolean;
    revokedAt?: string | null;
}

export interface IssuedCertResult extends IssuedCert {
    passphrase: string;
    crt: string;
    key: string;
}

export function getBrokerCA(): Promise<{ ca: CaInfo | null }> {
    return request('GET', '/she/broker/ca');
}

export function generateBrokerCA(opts?: { cn?: string; days?: number }): Promise<{ ok: boolean } & CaInfo> {
    return request('POST', '/she/broker/ca/generate', opts ?? {});
}

export function getBrokerServerCert(): Promise<{ server: ServerCertInfo | null }> {
    return request('GET', '/she/broker/ca/server');
}

export function generateBrokerServerCert(opts: {
    cn: string;
    san?: string[];
    days?: number;
}): Promise<{ ok: boolean; fingerprint: string; expires: string; certPath: string; keyPath: string }> {
    return request('POST', '/she/broker/ca/server/generate', opts);
}

export function generateBrokerServerCSR(opts: { cn: string; san?: string[] }): Promise<{ ok: boolean; csrPem: string }> {
    return request('POST', '/she/broker/ca/server/csr', opts);
}

export function importBrokerServerCert(body: { cert: string; key?: string } | { p12base64: string; passphrase?: string }): Promise<{ ok: boolean; server: ServerCertInfo }> {
    return request('POST', '/she/broker/ca/server/import', body);
}

export function listIssuedCerts(): Promise<{ certs: IssuedCert[] }> {
    return request('GET', '/she/broker/ca/certs');
}

export function issueClientCert(opts: { cn: string; days?: number }): Promise<{ ok: boolean } & IssuedCertResult> {
    return request('POST', '/she/broker/ca/certs', opts);
}

export function revokeClientCert(serial: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/ca/certs/${encodeURIComponent(serial)}`);
}

export function downloadCertUrl(serial: string, type: 'p12' | 'crt' | 'key' | 'ca'): string {
    return `/she/broker/ca/certs/${encodeURIComponent(serial)}/download?type=${type}`;
}

export function listTrustedCerts(): Promise<{ certs: TrustedCert[] }> {
    return request('GET', '/she/broker/ca/trusted');
}

export function addTrustedCert(pem: string): Promise<{ ok: boolean; filename: string; fingerprint: string }> {
    return request('POST', '/she/broker/ca/trusted', { pem });
}

export function removeTrustedCert(fingerprint: string): Promise<{ ok: boolean }> {
    return request('DELETE', `/she/broker/ca/trusted/${encodeURIComponent(fingerprint)}`);
}

export function brokerFsComplete(inputPath: string): Promise<{ suggestions: string[] }> {
    return request('GET', `/she/broker/fs/complete?path=${encodeURIComponent(inputPath)}`);
}

export function setBrokerServerCertPath(body: { certPath: string; keyPath: string }): Promise<{ ok: boolean; server: ServerCertInfo }> {
    return request('POST', '/she/broker/ca/server/pathlink', body);
}

export function addTrustedCertFromPath(filePath: string): Promise<{ ok: boolean; filename: string; fingerprint: string }> {
    return request('POST', '/she/broker/ca/trusted/addpath', { path: filePath });
}
