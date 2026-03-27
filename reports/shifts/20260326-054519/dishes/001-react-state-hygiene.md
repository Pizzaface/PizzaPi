# Dish 001: React State Hygiene — patchSessionCache Outside Updaters

- **Cook Type:** sonnet
- **Complexity:** M
- **Godmother ID:** MyhlJhuS
- **Dependencies:** none
- **Pairing:** ui-reliability
- **Pairing Role:** prelim
- **Pairing Partners:** 002-hub-socket-dedup
- **Paired:** true
- **Files:** packages/ui/src/App.tsx
- **Verification:** cd packages/ui && bun run typecheck; cd ../.. && bun test packages/ui
- **Status:** cooking
- **Session:** 57fce927-5390-4c55-ba35-b649afa1e1cd
- **dispatchPriority:** normal

## Task Description

### Problem
`patchSessionCache` is called as a side effect inside `setMessages` functional updaters in 7 locations in `packages/ui/src/App.tsx`. This violates React concurrent mode rules: React may call functional updaters multiple times speculatively. Side effects in updaters can double-fire, writing stale or uncommitted state to the cache.

Locations (confirmed by reality check):
- Line 758: `patchSessionCache({ messages: next })` inside `setMessages((prev) => { ... return next; })`
- Line 807: same pattern
- Line 1424: `patchSessionCache({ messages: deduped })` inside `setMessages((current) => { ... return deduped; })`
- Line 1760: `patchSessionCache({ messages: next })` inside `setMessages((prev) => { ... return next; })`
- Line 1795: `patchSessionCache({ messages: next })` inside `setMessages((prev) => { ... return next; })`
- Line 1819: `patchSessionCache({ messages: next })` inside `setMessages((prev) => { ... return next; })`
- Line 4034: `patchSessionCache({ messages: next })` inside `setMessages((prev) => { ... return next; })`

### Fix Strategy

Add a `messagesRef` that tracks the current messages value:
```ts
const messagesRef = React.useRef(messages);
// Keep in sync:
React.useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
```

Then at each violation location, change the pattern from:
```ts
// BEFORE (wrong — side effect in updater):
setMessages((prev) => {
  const next = transform(prev);
  patchSessionCache({ messages: next });  // ← side effect, may double-fire
  return next;
});
```
To:
```ts
// AFTER (correct):
const next = transform(messagesRef.current);
setMessages(next);                        // direct state set, no updater
patchSessionCache({ messages: next });    // side effect AFTER setState
```

**Important:** Before converting from a functional updater to a direct set, verify that the computation doesn't actually depend on stale closure values — i.e., that using `messagesRef.current` gives the right result. If `messagesRef.current` is kept up-to-date via `useLayoutEffect`, this is safe for event handlers.

For locations where the transformation is purely based on `prev` (previous messages) and doesn't use any other closure values, this pattern is safe. If any location has complex dependencies, add a comment explaining the safe-use constraints.

### Scope
- Only fix the 7 patchSessionCache-inside-setMessages violations
- Do NOT refactor other aspects of App.tsx
- Do NOT change the signature or behavior of patchSessionCache
- Do NOT touch SessionSidebar.tsx (that's dish 002)

### Verification
```bash
cd packages/ui && bun run typecheck
bun test packages/ui
```
TypeScript must be clean (exit code 0). Tests must pass.

## Status History
| Time | Status | Notes |
|------|--------|-------|
| 05:52 | queued | Created in Prep |
