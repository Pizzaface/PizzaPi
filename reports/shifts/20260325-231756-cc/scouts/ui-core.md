# Scout Report: UI Core
**Scout:** 24e4e8cc-e3c6-45be-9dba-d1ffe5358a85
**Sector:** UI Core
**Completed:** 2026-03-26 03:52 UTC

## Findings (12 bugs)

| # | Severity | Title | File |
|---|----------|-------|------|
| 1 | **P1** | Side effects inside setMessages updater (concurrent mode violation) | App.tsx:1421 |
| 2 | **P1** | Double /hub WebSocket — SessionSidebar + App open separate sockets | SessionSidebar.tsx:557 + App.tsx:2123 |
| 3 | **P1** | patchSessionCache called inside setMessages updater in 6+ locations | App.tsx:758,807,1424,1760,1795,1819 |
| 4 | **P1** | handleRelayEvent useCallback missing 4 deps — stale closures | App.tsx:2118 |
| 5 | P2 | Optimistic steer message not cached — disappears on session switch | App.tsx:2738 |
| 6 | P2 | SessionMessageItem memo comparator omits onTriggerResponse | SessionViewer.tsx:340 |
| 7 | P2 | handleEndSession temp socket no cleanup on unmount | App.tsx:2812 |
| 8 | P2 | ConversationExport anchor element leaks on error (no try/finally) | conversation.tsx:238 |
| 9 | P2 | ComposerAttachmentMeta fetches full blob just for file size | SessionViewer.tsx:222 |
| 10 | P2 | sortedMessages relies on sort stability for equal-timestamp msgs | SessionViewer.tsx:~1600 |
| 11 | P3 | message_start handler falls through without return | App.tsx:2104 |
| 12 | P3 | pluginTrustPrompt keys undefined when arrays mismatched | SessionViewer.tsx:1903 |

## Score
**0 P0, 4 P1, 6 P2, 2 P3** — deep React correctness audit, multiple concurrent-mode violations.
