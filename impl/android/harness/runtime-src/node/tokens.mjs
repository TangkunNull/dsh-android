// Size/radius/spacing tokens. Colours stay on the Flutter side (theme.dart)
// because they flip with dark mode at render time; sizes do not.
export const SIZE_TOKENS = {
  '--dsw-radius-xs': 4,
  '--dsw-radius-sm': 8,
  '--dsw-radius-md': 12,
  '--dsw-radius-lg': 16,
  '--dsw-radius-xl': 20,
  '--dsw-radius-full': 999,
  '--dsw-spacing-0': 0,
  '--dsw-spacing-1': 2,
  '--dsw-spacing-2': 4,
  '--dsw-spacing-3': 6,
  '--dsw-spacing-4': 8,
  '--dsw-spacing-5': 12,
  '--dsw-spacing-6': 16,
  '--dsw-spacing-7': 20,
  '--dsw-spacing-8': 24,
  '--dsw-font-size-xs': 11,
  '--dsw-font-size-sm': 13,
  '--dsw-font-size-md': 14,
  '--dsw-font-size-lg': 16,
  '--dsw-font-size-xl': 20,
  '--dsw-line-height-tight': 1.2,
  '--dsw-line-height-normal': 1.5,
  '--dsw-border-width': 1,
};

/** Resolve `var(--x)` / `var(--x, 4px)` against the size table. null if unknown. */
export function resolveSizeToken(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([^)]+))?\)$/);
  if (!m) return null;
  if (m[1] in SIZE_TOKENS) return SIZE_TOKENS[m[1]];
  if (m[2]) return parseFloat(m[2]);
  return null;
}
