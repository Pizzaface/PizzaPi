# Reality Check — 2026-03-26 05:50 UTC

| Godmother ID | Title | Verdict | Notes |
|--------------|-------|---------|-------|
| MyhlJhuS | React state hygiene — patchSessionCache in setMessages | ✅ Still needed | Found at App.tsx:758,807,1424,1760,1795,1819,4034 — 7 violations confirmed |
| wexNsZ1X | Double /hub WebSocket | ✅ Still needed | App.tsx:2121 and SessionSidebar.tsx:606 both call io("/hub") independently |
| i9uAYsf7 | Cross-node session_message/trigger fallback | ⚠️ Partially fixed | trigger_response has fallback (line 262); session_message (line 87) and session_trigger (line 180) still missing it in messaging.ts |
| cmHfFF7I | User attachment persistence | ⚠️ Partially fixed | System/extracted images have SQLite persistence; storeSessionAttachment (line 62–95) has no persist call — user uploads still in-memory only |
| CVM8j9cS | kill_session + exit(43) race | ✅ Still needed | No killedSessions Set exists; exit handler calls onRestartRequested() on code===43 unconditionally |
| AY73LYG4 | Tunnel WS proxy orphaned connections | ✅ Already fixed | packages/server/src/tunnel-ws.ts never exists; tunnel is HTTP-only |

## Action Taken
- AY73LYG4 → moved to "shipped" in Godmother (tunnel is HTTP-only, bug surface never existed)
- i9uAYsf7 → Godmother content updated to reflect reduced scope (2 handlers missing fallback)
- cmHfFF7I → Godmother content updated to reflect reduced scope (user uploads only)
- 5 dishes on tonight's menu
