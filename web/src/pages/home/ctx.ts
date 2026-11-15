/** What the Home page hands its tabs: running an edit, the dialogs, moving to another tab. */
export interface HomeCtx {
    /** run an edit; `done` is the note shown afterwards; resolves to its result, or undefined on an error (shown by the page) */
    act<T>(fn: () => Promise<T>, done?: string | ((r: T) => string | null)): Promise<T | undefined>;
    confirm(msg: string, opts?: { confirm?: string; danger?: boolean; alert?: boolean }): Promise<boolean>;
    prompt(msg: string, opts?: { placeholder?: string; confirm?: string; initial?: string }): Promise<string | null>;
    goto(tab: 'rooms' | 'devices' | 'scenes' | 'functions' | 'labels', focus?: { room?: string; device?: string; filter?: string }): void;
}
