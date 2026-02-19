import { useState } from "react";

interface Message {
    role: "user" | "assistant";
    content: string;
}

export function App() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);

    async function send() {
        if (!input.trim() || loading) return;

        const userMessage: Message = { role: "user", content: input };
        setMessages((prev) => [...prev, userMessage]);
        setInput("");
        setLoading(true);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    message: input,
                    provider: "anthropic",
                    model: "claude-sonnet-4-5-20250929",
                    apiKey: "",
                }),
            });

            const data = await res.json();
            setMessages((prev) => [...prev, { role: "assistant", content: data.response }]);
        } catch {
            setMessages((prev) => [...prev, { role: "assistant", content: "Error: Failed to get response" }]);
        } finally {
            setLoading(false);
        }
    }

    return (
        <div style={{ maxWidth: 800, margin: "0 auto", padding: 20 }}>
            <h1>PizzaPi</h1>
            <div style={{ minHeight: 400, border: "1px solid #333", borderRadius: 8, padding: 16, marginBottom: 16 }}>
                {messages.map((m, i) => (
                    <div key={i} style={{ marginBottom: 12 }}>
                        <strong>{m.role}:</strong> {m.content}
                    </div>
                ))}
                {loading && <div>Thinking...</div>}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
                <input
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && send()}
                    placeholder="Type a message..."
                    style={{ flex: 1, padding: 8 }}
                />
                <button onClick={send} disabled={loading}>
                    Send
                </button>
            </div>
        </div>
    );
}
