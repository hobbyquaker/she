/**
 * The script editor's docking layout on dockview-core: the editor is the fixed centre, the other
 * panels (file tree, log, runtime, AI chat) dock around it, split, tab, resize and close. The panels'
 * DOM is rendered by Svelte into a parking container; dockview adopts the elements when a panel is
 * opened and gives them back when it is closed, so the panels keep their state and reactivity.
 *
 * The layout is remembered per browser (localStorage, best-effort) and can be reset.
 */
import { createDockview, type DockviewApi, type IContentRenderer, type SerializedDockview, type Direction } from 'dockview-core';

export interface DockPanelDef {
    id: string;
    title: string;
    element: HTMLElement;
}

export interface DockPosition {
    referencePanel?: string;
    direction?: Direction;
    /** where to go, relative to the centre, when the reference panel is not open */
    fallback?: Direction;
}

export interface DockOpenOptions {
    position?: DockPosition;
    width?: number;
    height?: number;
    /** open without making it the active tab of its group */
    inactive?: boolean;
}

export interface DockOptions {
    panels: DockPanelDef[];
    /** the panel that is the fixed centre: locked group, no tab header, never closed */
    centre: string;
    storageKey: string;
    /** builds the default layout with open(); the centre is already there */
    defaultLayout: (open: (id: string, opts?: DockOpenOptions) => void) => void;
    /** called with the ids of the open panels whenever that set changes */
    onChange?: (open: Set<string>) => void;
}

export interface Dock {
    api: DockviewApi;
    open(id: string, opts?: DockOpenOptions): void;
    close(id: string): void;
    toggle(id: string): void;
    isOpen(id: string): boolean;
    openIds(): Set<string>;
    reset(): void;
    dispose(): void;
}

export const DOCK_THEME_CLASS = 'dockview-theme-she';

export function createDock(el: HTMLElement, opts: DockOptions): Dock {
    const byId = new Map(opts.panels.map((p) => [p.id, p]));
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let restoring = false;

    const api = createDockview(el, {
        theme: { name: 'she', className: DOCK_THEME_CLASS, gap: 0, dndOverlayMounting: 'absolute', colorScheme: 'dark' },
        disableFloatingGroups: true,
        createComponent: ({ id, name }): IContentRenderer => {
            const def = byId.get(name) ?? byId.get(id);
            if (!def) {
                const element = document.createElement('div');
                element.textContent = `unknown panel ${name}`;
                return { element, init() {} };
            }
            return { element: def.element, init() {} };
        },
    });

    function lockCentre() {
        const centre = api.getPanel(opts.centre);
        if (!centre) return;
        centre.group.locked = 'no-drop-target';
        centre.group.header.hidden = true;
    }

    function openIds(): Set<string> {
        return new Set(api.panels.map((p) => p.id));
    }

    function notify() {
        opts.onChange?.(openIds());
    }

    function save() {
        if (restoring) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            try {
                localStorage.setItem(opts.storageKey, JSON.stringify(api.toJSON()));
            } catch {
                /* private window, full storage — the layout is simply not remembered */
            }
        }, 300);
    }

    function open(id: string, o: DockOpenOptions = {}) {
        const existing = api.getPanel(id);
        if (existing) {
            if (!o.inactive) existing.api.setActive();
            return;
        }
        const def = byId.get(id);
        if (!def) return;
        // the first panel is the root; every other one is placed relative to its reference, or to
        // the centre when the reference is not open (never into the locked centre group itself)
        let position: { referencePanel: string; direction: Direction } | undefined;
        if (id !== opts.centre) {
            const want = o.position?.referencePanel ?? opts.centre;
            const refOpen = !!api.getPanel(want);
            position = refOpen
                ? { referencePanel: want, direction: o.position?.direction ?? 'right' }
                : { referencePanel: opts.centre, direction: o.position?.fallback ?? 'below' };
        }
        api.addPanel({
            id,
            component: id,
            title: def.title,
            position,
            initialWidth: o.width,
            initialHeight: o.height,
            inactive: o.inactive,
        });
        if (id === opts.centre) lockCentre();
    }

    function close(id: string) {
        if (id === opts.centre) return;
        api.getPanel(id)?.api.close();
    }

    function isOpen(id: string) {
        return !!api.getPanel(id);
    }

    function buildDefault() {
        restoring = true;
        try {
            api.clear();
            open(opts.centre);
            opts.defaultLayout(open);
            lockCentre();
        } finally {
            restoring = false;
        }
        save();
        notify();
    }

    function restore(): boolean {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(opts.storageKey);
        } catch {
            return false;
        }
        if (!raw) return false;
        restoring = true;
        try {
            const data = JSON.parse(raw) as SerializedDockview;
            api.fromJSON(data);
            if (!api.getPanel(opts.centre)) throw new Error('saved layout has no editor');
            lockCentre();
            return true;
        } catch {
            return false;
        } finally {
            restoring = false;
        }
    }

    api.onDidLayoutChange(() => save());
    api.onDidAddPanel(() => notify());
    api.onDidRemovePanel(() => notify());

    if (!restore()) buildDefault();
    else notify();

    return {
        api,
        open,
        close,
        toggle: (id) => (isOpen(id) ? close(id) : open(id)),
        isOpen,
        openIds,
        reset: buildDefault,
        dispose: () => {
            if (saveTimer) clearTimeout(saveTimer);
            api.dispose();
        },
    };
}
