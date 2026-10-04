import {
    createCodemodeExtension,
    createToolSearchExtension,
    type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

// PizzaPi uses a custom resource-loader factory list, so Pi's own CLI built-in
// extension list is not auto-loaded here. Add only the safe Pi 1.0 built-ins;
// PizzaPi still owns MCP connection/trust/OAuth/approval boundaries.
export const codemodeExtension: ExtensionFactory = createCodemodeExtension();
export const nativeToolSearchExtension: ExtensionFactory = createToolSearchExtension();
