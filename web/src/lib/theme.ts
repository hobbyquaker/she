export type Theme = 'dark' | 'light' | 'system';

const KEY = 'she-theme';

export function getTheme(): Theme {
    return (localStorage.getItem(KEY) as Theme) ?? 'dark';
}

export function setTheme(theme: Theme): void {
    localStorage.setItem(KEY, theme);
    const root = document.documentElement;
    if (theme === 'system') {
        root.removeAttribute('data-theme');
    } else {
        root.setAttribute('data-theme', theme);
    }
}
