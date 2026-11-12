import * as monaco from 'monaco-editor';

/**
 * Monaco binds a global hover-delegate factory to the services of the last editor it constructed, and the
 * inner editors of a diff editor bring their own services, which dispose() tears down. After a diff editor
 * was created or disposed, the main editor's find widget and command palette would be built from disposed
 * services: Ctrl+F, Ctrl+H and F1 did nothing ("InstantiationService has been disposed"), and every model
 * change then threw from the half-built find widget. A throwaway editor on the global services, created and
 * disposed at once, points the factory back at services that live as long as the page.
 *
 * Call it after a diff editor's setModel and after its dispose — whoever creates a diff editor anywhere on
 * the page owes the other editors this.
 */
export function resetMonacoHoverServices() {
    try {
        monaco.editor.create(document.createElement('div'), { automaticLayout: false }).dispose();
    } catch {
        /* nothing to restore when Monaco is not loaded */
    }
}
