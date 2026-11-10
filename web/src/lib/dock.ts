/**
 * The script editor's docking layout on dockview-core: the editor is the fixed centre, the other
 * panels (file tree, log, runtime, AI chat) dock around it, split, tab, resize and close. The panels'
 * DOM is rendered by Svelte into a parking container; dockview adopts the elements when a panel is
 * opened and gives them back when it is closed, so the panels keep their state and reactivity.
 *
 * Closing a panel hides its group (dockview's `setVisible(false)`): the group keeps its place in the
 * grid and its size, so the panel comes back exactly where it was. A panel closed out of a shared
 * (tabbed) group is removed and remembers that group. Both are persisted with the layout.
 *
 * The side panels keep their sizes: dockview distributes the space of a hidden, removed or moved
 * group evenly over the remaining siblings, which made the file tree jump to half the window. After
 * every structural change the sizes the user had are re-applied to the panels around the editor
 * (through the group API), so the editor alone absorbs the difference — see `holdSizes`.
 *
 * The layout is remembered per browser (localStorage, best-effort) and can be reset.
 *
 * The dock may be created while its page is hidden (the app was opened on another page): the
 * element then has no size, the widths and heights the default layout asks for are lost, and
 * dockview hands every panel an equal share once the page is shown. So a default layout built
 * without a size is built again the moment the element has one, and is not saved before.
 */
import {
    createDockview,
    type DockviewApi,
    type IContentRenderer,
    type ITabRenderer,
    type TabPartInitParameters,
    type SerializedDockview,
    type SerializedGridObject,
    type Direction,
    type IDockviewGroupPanel,
    type AddPanelPositionOptions,
} from 'dockview-core';

export interface DockPanelDef {
    id: string;
    title: string;
    element: HTMLElement;
}

export interface DockPosition {
    /** the panel to dock next to; without one the direction is relative to the whole dock (its edge) */
    referencePanel?: string;
    direction: Direction;
    /** direction relative to the centre when the reference panel is not open */
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

/** what is stored under the storage key */
interface StoredLayout {
    layout: SerializedDockview;
    /** panel id → the id of the (shared) group it was closed out of */
    homes: Record<string, string>;
}

/** the part of a serialized group that the size logic reads */
interface LeafData {
    id: string;
    views: string[];
}
type GridNode = SerializedGridObject<LeafData>;
type GridLeaf = GridNode & { data: LeafData };
type Dims = { width?: number; height?: number };

/** the share of the dock a panel takes when it is dropped beside the editor */
const NEW_SHARE = 0.3;

/**
 * A panel tab: the title and a close button that hides the panel through the dock (dockview's own
 * close removes the group, and with it the panel's place in the layout). Uses dockview's class names
 * so its tab styles apply.
 */
class PanelTab implements ITabRenderer {
    readonly element = document.createElement('div');
    private readonly content = document.createElement('div');
    private readonly action = document.createElement('button');
    private readonly disposers: (() => void)[] = [];

    constructor(private readonly onClose: () => void) {
        this.element.className = 'dv-default-tab';
        this.content.className = 'dv-default-tab-content';
        this.action.className = 'dv-default-tab-action';
        this.action.type = 'button';
        this.action.tabIndex = -1;
        this.action.textContent = '×';
        this.element.append(this.content, this.action);
    }

    init(params: TabPartInitParameters) {
        const render = (title: string | undefined) => {
            this.content.textContent = title ?? '';
            const label = `Hide ${title ?? 'panel'} — show it again from the toolbar`;
            this.action.title = label;
            this.action.setAttribute('aria-label', label);
        };
        render(params.title);
        const titleSub = params.api.onDidTitleChange((e) => render(e.title));
        // no tab drag from the close button, and the click does not activate the tab
        const onDown = (ev: PointerEvent) => ev.preventDefault();
        const onClick = (ev: MouseEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            this.onClose();
        };
        this.action.addEventListener('pointerdown', onDown);
        this.action.addEventListener('click', onClick);
        this.disposers.push(
            () => titleSub.dispose(),
            () => this.action.removeEventListener('pointerdown', onDown),
            () => this.action.removeEventListener('click', onClick)
        );
    }

    dispose() {
        this.disposers.splice(0).forEach((fn) => fn());
    }
}

function isLeaf(node: GridNode): node is GridLeaf {
    return node.type === 'leaf';
}
function children(node: GridNode): GridNode[] {
    return node.type === 'branch' ? (node.data as GridNode[]) : [];
}

/** the tree without sizes: group ids, their panels and visibility */
function structureOf(node: GridNode): string {
    if (isLeaf(node)) return `${node.data.id}(${node.data.views.join(',')})${node.visible === false ? '-' : ''}`;
    return `[${children(node).map(structureOf).join('|')}]`;
}

/** the child indexes from the root to the leaf holding the panel, or null */
function pathTo(node: GridNode, panelId: string): number[] | null {
    if (isLeaf(node)) return node.data.views.includes(panelId) ? [] : null;
    const kids = children(node);
    for (let i = 0; i < kids.length; i++) {
        const sub = pathTo(kids[i], panelId);
        if (sub) return [i, ...sub];
    }
    return null;
}

/** the node itself when it is a leaf, else a visible leaf among its direct children */
function directLeaf(node: GridNode): GridLeaf | undefined {
    if (isLeaf(node)) return node;
    return children(node).find((c): c is GridLeaf => isLeaf(c) && c.visible !== false);
}

/**
 * The sizes to hold, read from the serialized layout: on the way from the root to the centre's leaf,
 * every branch splits the space between the centre's side and the panels docked at that level; the
 * size of each such side node along the branch's axis (the width of a left or right column, the
 * height of a bottom row) is what the user set. Keyed by a group that can set it through its API —
 * the leaf itself, or a direct leaf child of a side branch (its orthogonal size is the branch's).
 * What happens inside a side branch (how a bottom row is split between two panels) stays
 * proportional — dockview's default — and is not held.
 */
function sizesToHold(layout: SerializedDockview, centre: string): Map<string, Dims> {
    const out = new Map<string, Dims>();
    const root = layout.grid.root as GridNode;
    const path = pathTo(root, centre);
    if (!path) return out;
    let node = root;
    // a HORIZONTAL branch lays its children out side by side: their sizes are widths
    let horizontal = layout.grid.orientation === 'HORIZONTAL';
    for (const index of path) {
        const kids = children(node);
        kids.forEach((child, i) => {
            if (i === index || child.visible === false || typeof child.size !== 'number') return;
            const leaf = directLeaf(child);
            if (!leaf) return;
            const dims = out.get(leaf.data.id) ?? {};
            dims[horizontal ? 'width' : 'height'] = child.size;
            out.set(leaf.data.id, dims);
        });
        node = kids[index];
        horizontal = !horizontal;
    }
    return out;
}

export function createDock(el: HTMLElement, opts: DockOptions): Dock {
    const byId = new Map(opts.panels.map((p) => [p.id, p]));
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let homes: Record<string, string> = {};
    /** group id → the size(s) that group holds for the user, see sizesToHold */
    let held = new Map<string, Dims>();
    /** the layout's structure the held sizes belong to; '' right after a rebuild */
    let structure = '';
    /** group id → visible, as of the last layout change: a group shown again is not a newcomer */
    let groupsBefore = new Map<string, boolean>();
    let lastOpen = '';
    /** the default layout was built while the element had no size and is built again when it has one */
    let awaitingSize = false;
    let sizeObserver: ResizeObserver | null = null;

    const hasSize = () => el.clientWidth > 0 && el.clientHeight > 0;

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
        // the tab renderer is only asked for when a tab component is named
        defaultTabComponent: 'panel-tab',
        createTabComponent: ({ id }) => new PanelTab(() => close(id)),
    });

    function lockCentre() {
        const centre = api.getPanel(opts.centre);
        if (!centre) return;
        // nothing is dropped into the editor's group as a tab, but its edges stay drop targets, so a panel can be
        // docked back below or beside the code instead of only along the whole dock's edge
        centre.group.locked = true;
        centre.group.header.hidden = true;
    }

    function groupById(id: string): IDockviewGroupPanel | undefined {
        return api.groups.find((g) => g.id === id);
    }

    function isOpen(id: string): boolean {
        const panel = api.getPanel(id);
        return !!panel && panel.group.api.isVisible;
    }

    function openIds(): Set<string> {
        return new Set(api.panels.filter((p) => p.group.api.isVisible).map((p) => p.id));
    }

    function notify() {
        const open = openIds();
        const key = [...open].sort().join(',');
        if (key === lastOpen) return;
        lastOpen = key;
        opts.onChange?.(open);
    }

    function save() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            // a layout without sizes is not worth remembering; the real one follows
            if (awaitingSize) return;
            try {
                const data: StoredLayout = { layout: api.toJSON(), homes };
                localStorage.setItem(opts.storageKey, JSON.stringify(data));
            } catch {
                /* private window, full storage — the layout is simply not remembered */
            }
        }, 300);
    }

    function open(id: string, o: DockOpenOptions = {}) {
        const existing = api.getPanel(id);
        if (existing) {
            // closed in place: the group is hidden and comes back with its size
            if (!existing.group.api.isVisible) existing.group.api.setVisible(true);
            if (!o.inactive) existing.api.setActive();
            return;
        }
        const def = byId.get(id);
        if (!def) return;
        let position: AddPanelPositionOptions | undefined;
        if (id !== opts.centre) {
            // back into the shared group it was closed out of, if that group still exists
            const home = homes[id] ? groupById(homes[id]) : undefined;
            if (home && home.api.location.type === 'grid') {
                if (!home.api.isVisible) home.api.setVisible(true);
                position = { referenceGroup: home.id, direction: 'within' };
            } else {
                // next to its reference panel; at the dock's edge without one; relative to the centre
                // when the reference is not open (never into the locked centre group itself)
                const p = o.position ?? { direction: 'right' as Direction };
                if (!p.referencePanel) position = { direction: p.direction };
                else if (isOpen(p.referencePanel)) position = { referencePanel: p.referencePanel, direction: p.direction };
                else position = { referencePanel: opts.centre, direction: p.fallback ?? p.direction };
            }
        }
        delete homes[id];
        const panel = api.addPanel({
            id,
            component: id,
            title: def.title,
            position,
            initialWidth: o.width,
            initialHeight: o.height,
            inactive: o.inactive,
        });
        // a new panel at the dock's edge is first given an equal share of the space, and a panel
        // added next to another takes it from whoever comes last: the size asked for is held too
        if (o.width || o.height) held.set(panel.group.id, { width: o.width, height: o.height });
        if (id === opts.centre) lockCentre();
    }

    function close(id: string) {
        if (id === opts.centre) return;
        const panel = api.getPanel(id);
        if (!panel) return;
        const group = panel.group;
        if (group.panels.length > 1) {
            // a tab among others: leave the group, remember it
            homes[id] = group.id;
            api.removePanel(panel);
        } else {
            // alone in its group: hide the group, it keeps its place and size
            group.api.setVisible(false);
        }
    }

    /**
     * Re-applies the held sizes after a structural change. Each group is pinned to its size (min =
     * max, which also applies it), so the space a later group gives or takes cannot land on one
     * already set and goes to the only free node on that level: the centre's side. The pins are
     * released afterwards, back to the constraints the groups had.
     */
    function holdSizes() {
        const pinned: { group: IDockviewGroupPanel; before: Record<'minW' | 'maxW' | 'minH' | 'maxH', number> }[] = [];
        // a group keeps a size only where it still sits beside the editor in the same direction: a panel
        // dragged from its own column into the editor's column keeps its group, and holding the column
        // width it had would squeeze the editor's whole column to it
        const now = sizesToHold(api.toJSON(), opts.centre);
        for (const [groupId, was] of held) {
            const group = groupById(groupId);
            if (!group || !group.api.isVisible || group.api.location.type !== 'grid') continue;
            const still = now.get(groupId);
            const dims: Dims = {
                width: still?.width !== undefined ? was.width : undefined,
                height: still?.height !== undefined ? was.height : undefined,
            };
            if (dims.width === undefined && dims.height === undefined) continue;
            pin(group, dims);
        }
        // a group that has just come to sit beside the editor (dropped on one of its edges) takes a modest
        // share instead of dockview's half of the editor
        for (const [groupId, is] of now) {
            const group = groupById(groupId);
            if (!group || !group.api.isVisible || group.api.location.type !== 'grid') continue;
            // shown again after a close: it comes back with its own size, not as a newcomer
            if (groupsBefore.get(groupId) === false) continue;
            const was = held.get(groupId);
            const dims: Dims = {
                width: is.width !== undefined && was?.width === undefined ? Math.min(is.width, Math.round(el.clientWidth * NEW_SHARE)) : undefined,
                height: is.height !== undefined && was?.height === undefined ? Math.min(is.height, Math.round(el.clientHeight * NEW_SHARE)) : undefined,
            };
            if (dims.width === undefined && dims.height === undefined) continue;
            pin(group, dims);
        }
        function pin(group: IDockviewGroupPanel, dims: Dims) {
            const before = { minW: group.minimumWidth, maxW: group.maximumWidth, minH: group.minimumHeight, maxH: group.maximumHeight };
            group.api.setConstraints({
                minimumWidth: dims.width,
                maximumWidth: dims.width,
                minimumHeight: dims.height,
                maximumHeight: dims.height,
            });
            pinned.push({ group, before });
        }
        for (const { group, before } of pinned) {
            group.api.setConstraints({
                minimumWidth: before.minW,
                maximumWidth: before.maxW,
                minimumHeight: before.minH,
                maximumHeight: before.maxH,
            });
        }
    }

    function onLayoutChange() {
        const now = structureOf(api.toJSON().grid.root as GridNode);
        // a structural change (a panel opened, closed or moved): dockview has redistributed the
        // space over the siblings — give the side panels their sizes back, the centre takes the rest
        if (structure !== '' && now !== structure) holdSizes();
        structure = now;
        held = sizesToHold(api.toJSON(), opts.centre);
        groupsBefore = new Map(api.groups.map((g) => [g.id, g.api.isVisible]));
        save();
        notify();
    }

    function buildDefault() {
        structure = '';
        held = new Map();
        homes = {};
        api.clear();
        open(opts.centre);
        // open() records the sizes the default layout asks for; they are applied once it is complete
        opts.defaultLayout(open);
        holdSizes();
        lockCentre();
        awaitingSize = !hasSize();
        if (awaitingSize) watchForSize();
    }

    /** Builds the default layout again once the element has a size, keeping closed what was closed meanwhile. */
    function watchForSize() {
        if (sizeObserver || typeof ResizeObserver === 'undefined') return;
        sizeObserver = new ResizeObserver(() => {
            if (awaitingSize && !hasSize()) return;
            sizeObserver?.disconnect();
            sizeObserver = null;
            if (!awaitingSize) return;
            const wasOpen = openIds();
            // dockview's own observer may not have run yet: the grid has to know its size before panels are placed
            api.layout(el.clientWidth, el.clientHeight);
            buildDefault();
            for (const p of opts.panels) {
                if (p.id !== opts.centre && !wasOpen.has(p.id)) close(p.id);
            }
        });
        sizeObserver.observe(el);
    }

    function restore(): boolean {
        let raw: string | null = null;
        try {
            raw = localStorage.getItem(opts.storageKey);
        } catch {
            return false;
        }
        if (!raw) return false;
        try {
            const data = JSON.parse(raw) as Partial<StoredLayout>;
            if (!data.layout?.grid) return false;
            // saved while the page was hidden (possible up to 3.0.0-beta.7): it carries no sizes
            if (!(data.layout.grid.width > 0) || !(data.layout.grid.height > 0)) return false;
            structure = '';
            held = new Map();
            api.fromJSON(data.layout);
            if (!api.getPanel(opts.centre)) throw new Error('saved layout has no editor');
            homes = data.homes && typeof data.homes === 'object' ? data.homes : {};
            lockCentre();
            return true;
        } catch {
            return false;
        }
    }

    api.onDidLayoutChange(() => onLayoutChange());

    if (!restore()) buildDefault();
    notify();

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
            sizeObserver?.disconnect();
            api.dispose();
        },
    };
}
