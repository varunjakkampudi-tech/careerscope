/**
 * Tracks whether any editor (saved leads, profile) has unsaved changes, so AuthenticatedShell's
 * session-expiry handler can check before it clears the query cache and redirects. A plain
 * module-level flag, not React state, on purpose: it is read once, synchronously, when a
 * session-expiry event fires, and never needs to trigger a re-render.
 */
let unsaved = false;

/** Records whether an editor currently has unsaved changes. */
export function setHasUnsavedChanges(dirty: boolean) {
  unsaved = dirty;
}

/** True if any editor reported unsaved changes. */
export function hasUnsavedChanges() {
  return unsaved;
}
