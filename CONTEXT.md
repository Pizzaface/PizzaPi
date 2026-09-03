# PizzaPi Trigger System

The unified trigger system: a single pub/sub model covering everything that used to be
child-session lifecycle triggers, service-declared triggers, webhook ingestion, and the
HTTP trigger API. One model, one code path.

## Language

### Trigger System

**Source**:
An emitter of Events: a child session, a runner service, a webhook endpoint, or the HTTP API.
_Avoid_: producer, publisher, origin

**Event**:
The immutable fact that a trigger fired — type, payload, source, timestamp. Never mutated after emit.
_Avoid_: trigger (as a noun for the fired thing), message, notification

**Route**:
A rule deciding which sessions receive an Event. Subsumes today's subscriptions and filters;
a direct-addressed fire is just an implicit Route to one session. Routes are tenant-scoped:
a Route matches only Events published by its `ownerUserId` (ownerless config routes are
operator-level and match all users).
_Avoid_: subscription, listener, binding

**Delivery**:
One per-session attempt to hand an Event to a recipient, with its own lifecycle
(pending → delivered → responded/expired). Durable: queued until the session is available, with TTL.
_Avoid_: dispatch, injection

**Event Type**:
A namespaced name (e.g. `lifecycle:session_complete`, `github:pr_comment`). Publishing currently
validates only the namespaced type string; registered payload schemas and publish-time schema
validation are future work. Routes can filter on payload fields.
_Avoid_: trigger type, kind

**Source Identity**:
The normalized, authenticated identity recorded on every Event, regardless of transport
(HMAC webhook, API key, socket auth).
_Avoid_: sender, origin

**Spawn-Spec**:
A Route target that creates a new session (cwd, model, prompt template) instead of
delivering to an existing one. Auto-spawn is just routing.
_Avoid_: trigger listener, auto-spawn rule

**Escalation Chain**:
The fallback path for an unanswered Response Contract: parent session → human viewer → expired.
_Avoid_: timeout handler

**Response Contract**:
An optional declaration on an Event that it awaits an answer (generalizes plan_review /
ask_question / session_complete acknowledgement). Any Event kind may carry one.
_Avoid_: pending trigger, question
