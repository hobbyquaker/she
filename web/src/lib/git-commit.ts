/**
 * Commits of script changes — the mode and the default message, mirrored from the daemon
 * (src/web/commit-message.js) so the Config and Scripts pages read the config the same way.
 */

export type CommitMode = 'off' | 'ask' | 'auto';

export const COMMIT_MODES: CommitMode[] = ['off', 'ask', 'auto'];

export interface CommitSettings {
    mode: CommitMode;
    /** auto mode asks the configured AI for the message (falls back to the default) */
    ai: boolean;
    autoPush: boolean;
}

/** The commit settings of a config object. An explicit `gitCommitMode` wins; the old `gitAutoCommit: true` means auto. */
export function resolveCommitMode(cfg: Record<string, unknown> | null | undefined): CommitSettings {
    const c = cfg ?? {};
    const mode: CommitMode = COMMIT_MODES.includes(c.gitCommitMode as CommitMode)
        ? (c.gitCommitMode as CommitMode)
        : c.gitAutoCommit === true ? 'auto' : 'off';
    return { mode, ai: mode === 'auto' && c.gitCommitAi === true, autoPush: c.gitAutoPush === true };
}

const pad = (n: number) => String(n).padStart(2, '0');

/** The default message: the changed files and the date and time, e.g. `update lights.js (2026-11-08 17:29)`. */
export function defaultCommitMessage(files: string[], now = new Date()): string {
    const list = files.filter(Boolean);
    const when = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    const what = list.length === 0 ? 'scripts' : list.length <= 3 ? list.join(', ') : `${list.slice(0, 3).join(', ')} and ${list.length - 3} more`;
    return `update ${what} (${when})`;
}
