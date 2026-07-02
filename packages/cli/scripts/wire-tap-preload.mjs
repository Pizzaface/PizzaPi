// Preload for the vanilla-pi leg of scripts/diff-pi-pizza.ts:
//   NODE_OPTIONS="--import <this file>" pi -p "hi"
// Installs the wire tap in the process's real main realm. pi loads -e
// extension files in a separate module realm whose globalThis is not the one
// the provider code reads, so an extension-based tap never sees the request.
import { installWireTap } from "./wire-tap.ts";

installWireTap("pi");
