# Audit: reference/protocol.mdx
Verdict: MAJOR ISSUES
Claims checked: 34 | Failed: 11

## Findings

### [P1] MetaRelayEvent count says 17 but the enumerated list has only 16 (goal_updated missing)
- Claim (line 332–334): "A discriminated union of 17 event types." then "Event types: `todo_updated`, `question_pending`, `question_cleared`, `plan_pending`, `plan_cleared`, `plan_mode_toggled`, `compact_started`, `compact_ended`, `retry_state_changed`, `plugin_trust_required`, `plugin_trust_resolved`, `mcp_startup_report`, `token_usage_updated`, `thinking_level_changed`, `auth_source_changed`, `model_changed`."
- Reality: The union has 17 members but the list omits `goal_updated`. `MetaRelayEvent` includes `| { type: "goal_updated"; goal: MetaGoalStatus | null }` and `META_RELAY_EVENT_TYPES` contains `"goal_updated"` (packages/protocol/src/meta.ts:60, 71, 78, 138). The count is right; the enumeration is wrong.
- Fix: Append `goal_updated` to the event-types list.

### [P1] "Relationship to Server & CLI" table gives wrong server handler paths
- Claim (lines 409–415): server handlers at `packages/server/src/socket/relay.ts`, `…/socket/runner.ts`, `…/socket/viewer.ts`, `…/socket/hub.ts`, `…/socket/runners.ts`, `…/socket/terminal.ts`, and meta interception at `packages/server/src/socket/relay.ts`.
- Reality: No `packages/server/src/socket/` directory exists. Actual handlers live under `packages/server/src/ws/namespaces/`: `runner.ts`, `viewer.ts`, `hub.ts`, `runners.ts`, `terminal.ts` (verified via find), and the relay handler is a directory `packages/server/src/ws/namespaces/relay/index.ts`. Meta interception is in `packages/server/src/ws/namespaces/relay/event-pipeline.ts:394,436` (where `isMetaRelayEvent` is imported and called), not a `socket/relay.ts` file.
- Fix: Replace every `packages/server/src/socket/<x>.ts` with `packages/server/src/ws/namespaces/<x>.ts` (relay → `ws/namespaces/relay/index.ts`; meta → `ws/namespaces/relay/event-pipeline.ts`).

### [P2] /runner server→client events: large number of real events omitted
- Claim (lines ~210–230): "Key server→client events" table lists runner_registered, new_session, kill_session/session_ended, skill CRUD, agent CRUD, list_plugins, list_files/search_files/read_file, list_models/get_usage, terminal PTY control, service_message, sandbox_get_status/sandbox_update_config, restart/shutdown/ping.
- Reality: `RunnerServerToClientEvents` (packages/protocol/src/runner.ts:281–470) also defines `list_sessions`, `list_terminals`, `analyze_session`, `settings_get_config`, `settings_update_section`, `packages_list`, `packages_install`, `packages_remove`, `packages_update`, `trigger_subscriptions_snapshot`, `trigger_subscription_delta`, `reconfigure_services`, and `error`. None are documented. This is a substantial chunk of the runner protocol (settings, package management, trigger-subscription reconciliation, session analysis) silently absent.
- Fix: Add rows for the missing events, or explicitly state the table is illustrative and link to `runner.ts` for the exhaustive list.

### [P2] /runner client→server events: trigger-subscription and analyze events omitted
- Claim (lines ~190–205): client→server table omits subscription ack and analysis responses.
- Reality: `RunnerClientToServerEvents` (packages/protocol/src/runner.ts:128–262) defines `trigger_subscriptions_applied`, `analyze_session_data`, and `analyze_session_error`, none of which appear in the doc. The trigger-subscription reconciliation system (`TriggerSubscriptionsSnapshot`/`TriggerSubscriptionDelta`/`TriggerSubscriptionsApplied`, runner.ts:18–75) is entirely undocumented.
- Fix: Add rows for `trigger_subscriptions_applied`, `analyze_session_data`, `analyze_session_error`; add a subsection on the trigger-subscription reconciliation types.

### [P2] /viewer server→client events: four real events omitted
- Claim (lines ~140–155): server→client table lists connected, event, disconnected, service_message, service_announce, trigger_error.
- Reality: `ViewerServerToClientEvents` (packages/protocol/src/viewer.ts:18–86) also defines `exec_result`, `service_announce_delta`, `error`, and `session_messages_page`. `service_announce_delta` is a first-class delta channel and `session_messages_page` backs pagination — both user-visible features.
- Fix: Add the four missing events; note `service_announce_delta` as the incremental companion to `service_announce`.

### [P2] /viewer client→server events: `connected` and `load_messages` omitted
- Claim (lines ~125–135): client→server table lists switch_session, resync, input, model_set, exec, service_message, trigger_response, mcp_oauth_paste.
- Reality: `ViewerClientToServerEvents` (packages/protocol/src/viewer.ts:91–154) also defines `connected` (viewer greeting that triggers TUI capabilities push) and `load_messages` (pagination request paired with the `session_messages_page` server event).
- Fix: Add `connected` and `load_messages` rows.

### [P2] /relay server→client events: `connected`, `session_message`, `session_message_error`, `error` omitted
- Claim (lines ~95–110): server→client table lists registered, event_ack, input, model_set, exec, session_trigger, trigger_response, parent_delinked, session_expired.
- Reality: `RelayServerToClientEvents` (packages/protocol/src/relay.ts:130–227) also defines `connected` (viewer-connected notification), `session_message` (inter-session message delivery), `session_message_error`, and a generic `error`. `session_message` is the reverse of a documented client→server event and should be paired.
- Fix: Add the four missing server→client events.

### [P2] /relay client→server: `get_linked_child_count` omitted
- Claim (lines ~75–90): client→server table lists register, event, session_end, session_message, session_trigger, trigger_response, cleanup_child_session, delink_children, delink_own_parent, exec_result.
- Reality: `RelayClientToServerEvents` (packages/protocol/src/relay.ts:118–125) defines `get_linked_child_count` with an ack returning `{ ok, count?, error? }`, used by the parent to query live child count.
- Fix: Add a `get_linked_child_count` row.

### [P2] RunnerInfo type missing `disabledServiceIds` and `sigilDefs`
- Claim (lines ~255–270): the documented `RunnerInfo` interface lists runnerId, name, roots, sessionCount, skills, agents, plugins, hooks, version, platform, serviceIds, panels, triggerDefs, warnings.
- Reality: `RunnerInfo` (packages/protocol/src/shared.ts:48–75) also defines `disabledServiceIds?: string[]` and `sigilDefs?: ServiceSigilDef[]`. The sigil system (`ServiceSigilDef`, shared.ts:178–220) is entirely undocumented in this page.
- Fix: Add `disabledServiceIds` and `sigilDefs` fields; add a short subsection on `ServiceSigilDef` (and the `ServiceAnnounceDelta`/`TriggerFilter`/`TriggerFilterMode` shared types that are also exported but not described).

### [P2] ServicePanelInfo missing `panelParams`
- Claim (lines ~285–292): documented `ServicePanelInfo` has `serviceId`, `port`, `label`, `icon`.
- Reality: `ServicePanelInfo` (packages/protocol/src/shared.ts:131–147) also defines `panelParams?: Record<string, string>` — resolved key-value pairs for variables the panel requires, populated by the daemon.
- Fix: Add the `panelParams` field and a one-line note on daemon variable resolution.

### [P2] SessionMetaState table missing `thinkingLevel`, `authSource`, `goal`
- Claim (lines ~315–330): the field table lists todoList, pendingQuestion, pendingPlan, planModeEnabled, isCompacting, retryState, pendingPluginTrust, mcpStartupReport, tokenUsage, providerUsage, model, version.
- Reality: `SessionMetaState` (packages/protocol/src/meta.ts:83–99) also defines `thinkingLevel: string | null`, `authSource: string | null`, and `goal: MetaGoalStatus | null`. `MetaGoalStatus` (meta.ts:64–74) is a whole sub-structure (id, description, status, turnCount, maxTurns, tokenSpend, maxTokens, costSpend, maxCost, lastReason) with no doc coverage. `thinkingLevel` and `authSource` are mentioned only indirectly via event names.
- Fix: Add `thinkingLevel`, `authSource`, and `goal` rows to the table; document `MetaGoalStatus`.

### [P3] `registered` payload description is partial
- Claim (line ~99): "registered | Confirm registration — returns `sessionId`, `token`, `shareUrl`."
- Reality: `registered` (packages/protocol/src/relay.ts:135–154) also returns `isEphemeral`, `collabMode`, `parentSessionId`, `serverTime`, `supportsSessionTriggerAck`, and `wasDelinked`. The `wasDelinked`/`supportsSessionTriggerAck` flags are behaviorally important for the documented trigger/delink flows.
- Fix: Either list the full payload or say "includes …" and link to `relay.ts`.

## Redesign notes
- The page uses "Key … events" phrasing for every namespace table, which reads as exhaustive but isn't. Either mark each table explicitly as illustrative (with a pointer to the source file for the full map) or make them exhaustive — the current middle ground causes systematic under-documentation.
- The shared-types section cherry-picks types (`ServiceSigilDef`, `ServiceAnnounceDelta`, `TriggerFilter`, `TriggerFilterMode`, `ServiceTriggerParamDef`, `JsonValue`, `MetaGoalStatus` are exported from `index.ts` but never described). Consider a complete "exported types" appendix or cross-links.
- The trigger-subscription reconciliation subsystem (snapshot/delta/applied, runner.ts:18–75 + events) is a non-trivial protocol feature with its own ordering/revision semantics and deserves its own subsection, parallel to the meta-state section.
- The "Relationship to Server & CLI" table is the only place that maps protocol files to handler code; it should be generated or at least smoke-tested against the actual tree, since it has rotted completely on the server side.
- The data-flow diagram is accurate but doesn't mention the service-announce delta path or the message-pagination path (`load_messages` ↔ `session_messages_page`), both of which are now real flows.

## Code UX opportunities
- The protocol package already co-locates `.test.ts` files per namespace; a small script could assert that every event name in each `*ClientToServerEvents`/`*ServerToClientEvents` interface appears in the corresponding docs table, turning this class of drift into a CI failure.
- `META_RELAY_EVENT_TYPES` is a runtime Set already used for validation; the docs could reference it directly (or the page could be generated from it) so the "17 event types" list can't drift from code.
- Several runner server→client events (`settings_get_config`, `packages_*`, `analyze_session`) have no CLI-side discoverability from the web UI docs; if these are intended user-facing features, their absence from this reference signals they may also be under-exposed in the UI.