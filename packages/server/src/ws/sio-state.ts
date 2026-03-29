// ============================================================================
// sio-state.ts — Backward-compat shim
//
// This file exists so that any consumer importing "./sio-state" or
// "./sio-state.js" continues to resolve correctly after the monolithic
// sio-state.ts was split into packages/server/src/ws/sio-state/ (11 modules).
//
// All internal imports already use the new explicit path:
//   import { ... } from "./sio-state/index.js"
//
// This shim preserves the old path for any external consumer or plugin
// that still references the pre-split module location.
// ============================================================================

export * from "./sio-state/index.js";
