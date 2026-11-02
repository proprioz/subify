import type { Theme } from '../data/settings';

/**
 * Applies the theme chosen in Settings: light, dark, or the device's setting, followed as it
 * changes. Returns a function that stops following it.
 */
export function applyTheme(theme: Theme): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => document.documentElement.classList.toggle('ion-palette-dark', theme === 'dark' || (theme === 'system' && query.matches));

  apply();
  query.addEventListener('change', apply);

  return () => query.removeEventListener('change', apply);
}
