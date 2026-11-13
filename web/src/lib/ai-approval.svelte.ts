/**
 * What the AI chat may do without a click — one setting, shared by the chat (which shows the select) and the
 * script editor (whose diff view honours it).
 *
 *  - `ask`      every script change and every publish waits for a click
 *  - `scripts`  script drafts and code proposals for the open script are applied at once
 *  - `publish`  additionally, publish requests go through without asking
 *
 * `scripts` survives a reload; `publish` never does — letting the assistant publish unattended is a decision
 * for the running session only, so it is stored as `scripts`.
 */
export type AiApproval = 'ask' | 'scripts' | 'publish';

const KEY = 'she:aiApprove';

function stored(): AiApproval {
    try {
        return localStorage.getItem(KEY) === 'scripts' ? 'scripts' : 'ask';
    } catch {
        return 'ask';
    }
}

let mode = $state<AiApproval>(stored());

export const aiApproval = {
    get mode(): AiApproval {
        return mode;
    },
    set mode(value: AiApproval) {
        mode = value === 'scripts' || value === 'publish' ? value : 'ask';
        try {
            localStorage.setItem(KEY, mode === 'ask' ? 'ask' : 'scripts');
        } catch {
            /* private mode: the choice lasts the session */
        }
    },
    /** script changes are applied without a click */
    get scripts(): boolean {
        return mode !== 'ask';
    },
    /** publish requests go through without a click */
    get publish(): boolean {
        return mode === 'publish';
    },
};
