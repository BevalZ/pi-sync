/**
 * Test-only stub for @earendil-works/pi-tui.
 *
 * The pure functions under test never invoke these; the stub exists only so
 * that jiti can resolve enhanced-select.ts's value imports when it loads the
 * extension module graph in a test environment without the real TUI package.
 */
export const Key = {};
export function matchesKey() {
  return false;
}
export function truncateToWidth(s) {
  return s;
}
export function visibleWidth(s) {
  return typeof s === "string" ? s.length : 0;
}
