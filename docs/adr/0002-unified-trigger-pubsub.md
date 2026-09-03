# Unify all trigger pathways into one pub/sub Event/Route/Delivery model

Status: accepted

PizzaPi grew six overlapping trigger pathways (child-session lifecycle triggers, service
subscriptions, direct HTTP fire, webhook ingestion, runner auto-spawn listeners, `time:*`
schedules), each with divergent schemas, defaults, persistence, and auth. We are replacing
all of them with a single pub/sub model — Source → Event → Route → Delivery — as a breaking
change. Direct-addressed fires become an implicit Route; auto-spawn becomes a Route with a
Spawn-Spec target; webhooks become Sources decoupled from spawning; schedules become a
built-in scheduler Source. See `CONTEXT.md` for the canonical vocabulary.

## Key choices

- **Tenant-scoped routing.** Every Event carries the authenticated publisher's `userId`;
  every Route carries an `ownerUserId` stamped from the creating principal. A Route only
  matches its owner's Events (config-file routes without an owner are operator-level and
  match everyone). `fireId` idempotency is scoped per owner. Rejected a global bus with
  per-route ACLs: the failure mode (one user's publish firing another user's spawn route)
  is exactly what tenant scoping makes impossible by construction.
- **Pub/sub only, one code path.** Rejected keeping direct-addressed firing as a distinct
  kind — the duplication is exactly the sprawl we're removing.
- **Delivery records are durable and exactly-once** per (event, session), with per-source
  FIFO, TTL/expiry, and an escalation chain (parent → human viewer) for unanswered Response
  Contracts. Socket delivery to ack-capable sessions (CLIs that declare `acksSessionTrigger`
  on register) is receipt-confirmed: the engine claims the row `pending → inflight`, emits
  with a Socket.IO ack keyed by deliveryId, and `delivered` records the recipient's
  confirmed receipt. Ack timeout or disconnect returns the row to `pending` so the next
  register re-delivers (the CLI dedups by triggerId, so re-delivery is safe), and a sweep
  backstops rows stuck inflight. Legacy CLIs keep handoff-equals-delivered semantics.
  Responses recorded while the source session was unreachable drain to it on its next
  registration (`responseRelayPending`).
- **Routes decide steer/followUp** (recipient-side), replacing today's divergent per-path
  defaults (HTTP/webhooks steered, broadcasts queued).
- **Typed Event registry** with declared payload schemas and default renderers; the
  `payload.prompt` convention dies. Routes may override with a prompt template.
- **SQLite is the durable store** for Events/Deliveries/Routes; Redis is live-queue/fan-out
  only. Rejected Redis-primary (today's 200-entry/24h history contradicts 30-day retention).
- **One `POST /api/events` publish endpoint**; webhook HMAC endpoints become thin adapters
  onto it; the Socket.IO fire fallback is deleted. Auth stays transport-appropriate but is
  normalized into a Source Identity recorded on every Event.
- **Config-declared Routes are read-only in the UI**; the config file is their source of
  truth. Rejected UI-wins and override layering as sync headaches.

- **Relay-only.** Offline/local sessions lose triggers entirely; tools return a clear
  "requires relay" error. Rejected a runner-local event bus as a second code path.
- **Human escalation = web-push** (existing infra). After the push attempt, the engine
  marks the Delivery expired. A pending-human entry in the global feed is future work.

## Consequences

- All existing callers (fire_trigger, trigger-broadcast, webhook fire, subscription APIs,
  runner listener CRUD) must migrate; no back-compat shims.
- Lifecycle triggers (ask_question, plan_review, session_complete) ride the same model via
  Response Contracts, so pending-trigger detection is schema-driven, not a hardcoded kind set.
