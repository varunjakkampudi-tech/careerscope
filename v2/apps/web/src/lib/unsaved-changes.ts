// CS-36 (Independent Reviewer finding 2, 2026-09-24): saved-leads.tsx and
// profile-editor.tsx already track a local "dirty" flag with their own
// discard-confirmation dialogs for in-app navigation, but that state was
// being thrown away at the page level (`const [, setDirty] = useState(...)`)
// and was invisible to AuthenticatedShell's session-expiry handler, which
// unconditionally cleared the query cache and redirected. This is a plain
// module-level flag, not React state, on purpose: it only needs to be read
// once, synchronously, at the moment a session-expiry event fires - it does
// not need to trigger a re-render anywhere.
let unsaved = false;

export function setHasUnsavedChanges(dirty: boolean) {
  unsaved = dirty;
}

export function hasUnsavedChanges() {
  return unsaved;
}
