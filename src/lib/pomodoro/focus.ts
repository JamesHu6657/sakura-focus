// The element that opened the settings sheet, stashed before `inert` lands
// on <main> (applying inert unfocuses it, so it can't be read back inside
// an effect). Restored when the sheet closes.
let openerFocus: HTMLElement | null = null;

export function stashOpenerFocus() {
  if (typeof document !== "undefined") {
    openerFocus = document.activeElement as HTMLElement | null;
  }
}

export function restoreOpenerFocus() {
  openerFocus?.focus?.();
  openerFocus = null;
}
