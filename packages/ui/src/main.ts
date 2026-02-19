import {
    ChatPanel,
    AppStorage,
    IndexedDBStorageBackend,
    SettingsStore,
    ProviderKeysStore,
    SessionsStore,
    setAppStorage,
} from "@mariozechner/pi-web-ui";
import { createToolkit } from "@pizzapi/tools";

// Initialize storage
const storage = new AppStorage(new IndexedDBStorageBackend("pizzapi"));
setAppStorage(storage);

// Mount the chat panel from pi-web-ui
const app = document.getElementById("app")!;
const chatPanel = new ChatPanel();

// Configure with PizzaPi's tools
chatPanel.setAttribute("title", "PizzaPi");
app.appendChild(chatPanel);

console.log("PizzaPi UI loaded — powered by @mariozechner/pi-web-ui");
