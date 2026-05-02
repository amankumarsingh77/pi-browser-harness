const VIRTUAL_KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, " ": 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
};

export const SPECIAL_KEYS: ReadonlyArray<string> = Object.keys(VIRTUAL_KEY_CODES);

export const virtualKeyCode = (key: string): number =>
  VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0);
