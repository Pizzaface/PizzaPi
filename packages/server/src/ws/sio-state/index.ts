// ============================================================================
// sio-state/index.ts — Re-export from the consolidated sio-state module
//
// All state logic now lives in ../sio-state.ts with dependency injection.
// This barrel exists so that existing imports from "./sio-state/index.js"
// continue to resolve correctly.
// ============================================================================

export * from "../sio-state.js";
