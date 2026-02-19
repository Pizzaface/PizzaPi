import {
    ApiKeyPromptDialog,
    ChatPanel,
    AppStorage,
    IndexedDBStorageBackend,
    setAppStorage,
    SettingsStore,
    ProviderKeysStore,
    SessionsStore,
    CustomProvidersStore,
} from "@mariozechner/pi-web-ui";
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import "./style.css";

// Create stores
const settings = new SettingsStore();
const providerKeys = new ProviderKeysStore();
const sessions = new SessionsStore();
const customProviders = new CustomProvidersStore();

// Gather all store configs (including session metadata)
const configs = [
    settings.getConfig(),
    SessionsStore.getMetadataConfig(),
    providerKeys.getConfig(),
    customProviders.getConfig(),
    sessions.getConfig(),
];

// Create backend
const backend = new IndexedDBStorageBackend({
    dbName: "pizzapi",
    version: 2,
    stores: configs,
});

// Wire backend to each store
settings.setBackend(backend);
providerKeys.setBackend(backend);
customProviders.setBackend(backend);
sessions.setBackend(backend);

// Create and set app storage
const storage = new AppStorage(settings, providerKeys, sessions, customProviders, backend);
setAppStorage(storage);

async function initApp() {
    const app = document.getElementById("app");
    if (!app) throw new Error("App container not found");

    // Create ChatPanel and add to DOM first (LitElement needs connectedCallback)
    const chatPanel = new ChatPanel();
    app.appendChild(chatPanel);

    // Create agent
    const agent = new Agent({
        initialState: {
            systemPrompt: "You are PizzaPi, a helpful AI assistant.",
            model: getModel("anthropic", "claude-sonnet-4-5-20250929"),
            thinkingLevel: "off",
            messages: [],
            tools: [],
        },
    });

    // Use the proper setAgent API (sets up AgentInterface, ArtifactsPanel, tools, etc.)
    await chatPanel.setAgent(agent, {
        onApiKeyRequired: async (provider: string) => {
            return await ApiKeyPromptDialog.prompt(provider);
        },
    });

    console.log("PizzaPi UI loaded — powered by @mariozechner/pi-web-ui");
}

initApp();
