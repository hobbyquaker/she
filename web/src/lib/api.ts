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
