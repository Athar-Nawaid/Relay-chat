const KEY = 'relay.theme.v1';
export const THEMES = ['system', 'light', 'dark'];

/**
 * Three states, not two.
 *
 * "system" means no attribute at all, so `prefers-color-scheme` decides — which
 * is what most people actually want. An explicit choice stamps the root element
 * and wins over the media query in both directions.
 */
export function getTheme() {
  try {
    const stored = localStorage.getItem(KEY);
    return THEMES.includes(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;

  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);

  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // Preference just won't survive a reload.
  }
}

/** Cycles system -> light -> dark -> system. */
export function nextTheme(current) {
  return THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
}

export const themeIcon = (theme) =>
  theme === 'light' ? '☀' : theme === 'dark' ? '☾' : '◐';

export const themeLabel = (theme) =>
  theme === 'light' ? 'Light theme' : theme === 'dark' ? 'Dark theme' : 'System theme';

// Apply immediately on module load, before React paints, so there is no flash.
applyTheme(getTheme());
