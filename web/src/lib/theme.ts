export type Theme = 'dark' | 'light' | 'system';

const KEY = 'she-theme';

export function getTheme(): Theme {
    return (localStorage.getItem(KEY) as Theme) ?? 'system';
}

export function setTheme(theme: Theme): void {
    localStorage.setItem(KEY, theme);
    const root = document.documentElement;
    if (theme === 'system') {
        root.removeAttribute('data-theme');
    } else {
        root.setAttribute('data-theme', theme);
    }
    window.dispatchEvent(new CustomEvent('she:theme-changed'));
}

/** Returns the Monaco editor theme string matching the current effective theme. */
export function resolveMonacoTheme(): 'vs-dark' | 'vs' {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'light') return 'vs';
    if (attr === 'dark') return 'vs-dark';
    // system — honour OS preference
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'vs-dark' : 'vs';
}
