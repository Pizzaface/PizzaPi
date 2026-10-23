/**
 * Score linked-session benchmark runs written by run.ts.
 *
 *   bun tests/bench/linked-sessions/analyze.ts /tmp/lbench [labelA labelB ...]
 *
 * Per run, then median [min–max] per label.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Msg = { role?: string; content?: any; usage?: any; details?: any; toolName?: string; toolCallId?: string };
type Entry = { type: string; timestamp?: string; message?: Msg; customType?: string; content?: any; details?: any };

const root = process.argv[2] ?? "/tmp/lbench";
const labels = process.argv.length > 3 ? process.argv.slice(3) : readdirSync(root).filter((d) => !d.startsWith("."));

function readJsonl(f: string): Entry[] {
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const textOf = (c: any): string => typeof c === "string" ? c : Array.isArray(c) ? c.map((x) => x?.text ?? "").join("\n") : "";
const calls = (es: Entry[]) => es.flatMap((e) => e.message?.role === "assistant" && Array.isArray(e.message.content)
  ? e.message.content.filter((c: any) => c?.type === "toolCall").map((c: any) => ({ ...c, ts: e.timestamp })) : []);

function scoreRun(dir: string) {
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const events: any[] = JSON.parse(readFileSync(join(dir, "events.json"), "utf8"));
  const human: any[] = JSON.parse(readFileSync(join(dir, "human.json"), "utf8"));
  const diff = readFileSync(join(dir, "repo.diff"), "utf8");

  // Transcripts → sessions; tree via spawn_session prompt ↔ child first user message.
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : f.name.endsWith(".jsonl") && files.push(join(d, f.name)); };
  if (existsSync(join(dir, "sessions"))) walk(join(dir, "sessions"));
  const sessions = files.map((f) => {
    const es = readJsonl(f);
    const firstUser = textOf(es.find((e) => e.message?.role === "user")?.message?.content);
    return { f, es, firstUser, calls: calls(es), parent: null as null | number, id: "" };
  });
  sessions.forEach((s, i) => {
    for (const c of s.calls.filter((c: any) => c.name === "spawn_session")) {
      const p = String(c.arguments?.prompt ?? "").slice(0, 200);
      const child = sessions.findIndex((o) => o !== s && o.firstUser.startsWith(p.slice(0, 120)));
      if (child >= 0) sessions[child].parent = i;
    }
  });
  const depthOf = (i: number): number => sessions[i].parent === null ? 1 : 1 + depthOf(sessions[i].parent!);
  const rootIdx = sessions.findIndex((s) => s.firstUser.startsWith("BENCHMARK TASK"));
  const all = sessions.flatMap((s) => s.calls);
  const rootCalls = rootIdx >= 0 ? sessions[rootIdx].calls : [];

  // Relays: an outbound message/prompt/follow-up that re-sends content this
  // session RECEIVED from a different session — ≥4 shared "content" words that
  // appear in neither the task prompt nor the fixture (paraphrase-tolerant).
  const words = (t: string) => new Set((t.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []));
  const scen = join(import.meta.dir, "scenarios", meta.scenario ?? "slugify");
  const fixtureText = (d: string): string => readdirSync(d, { withFileTypes: true })
    .map((f) => f.isDirectory() ? fixtureText(join(d, f.name)) : readFileSync(join(d, f.name), "utf8")).join("\n");
  const baseVocab = words(readFileSync(join(scen, "prompt.md"), "utf8") + fixtureText(join(scen, "fixture"))
    + " session sessions child children parent lead reviewer review report reports done tests test pass passes passing wait waiting please thanks repo work task file files src added updated");
  const shingles = (t: string) => new Set([...words(t)].filter((w) => !baseVocab.has(w)));
  const relaysIn = (s: (typeof sessions)[number]) => {
    const received: Array<{ from: string; sh: Set<string> }> = [];
    let n = 0;
    for (const e of s.es) {
      if (e.type === "custom_message") {
        const t = textOf(e.content);
        const from = t.match(/source:(\S+)/)?.[1] ?? t.match(/linked session ([0-9a-f-]{36})/)?.[1] ?? "?";
        received.push({ from, sh: shingles(t) });
      }
      const m = e.message;
      if (m?.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const c of m.content.filter((x: any) => x?.type === "toolCall")) {
        const a = c.arguments ?? {};
        const out = c.name === "send_message" ? { to: a.sessionId, t: a.message }
          : c.name === "spawn_session" ? { to: "new", t: a.prompt }
          : c.name === "respond_to_trigger" && a.action === "followUp" ? { to: "trigger", t: a.response } : null;
        if (!out?.t) continue;
        const sh = shingles(String(out.t));
        const hit = received.find((r) => r.from !== out.to && [...r.sh].filter((x) => sh.has(x)).length >= 4);
        if (hit) { n++; if (process.env.DEBUG) console.error(`relay ${c.name} from ${hit.from.slice(0, 8)}: ${String(out.t).slice(0, 80)}`); }
      }
    }
    return n;
  };
  const hubRelays = rootIdx >= 0 ? relaysIn(sessions[rootIdx]) : 0;
  const allRelays = sessions.reduce((n, s) => n + relaysIn(s), 0);
  const rootMsgs = rootCalls.filter((c: any) => c.name === "send_message" || (c.name === "respond_to_trigger" && c.arguments?.action === "followUp"));

  // Child questions (event log) — who answered, hops, latency.
  const asks = events.filter((e) => String(e.type).includes("ask_question"));
  const humanDeliveries = new Set(human.map((h) => h.deliveryId).filter(Boolean));
  let askHuman = 0, askAgent = 0, askOpen = 0, askHops = 0; const askLat: number[] = [];
  for (const e of asks) {
    const ds: any[] = e.deliveries ?? [];
    askHops += ds.length;
    const r = ds.find((d) => d.status === "responded" && d.respondedAt);
    const answeredByHuman = ds.some((d) => humanDeliveries.has(d.deliveryId));
    if (!r && !answeredByHuman) askOpen++;
    else if (answeredByHuman) askHuman++;
    else askAgent++;
    if (r) askLat.push((Date.parse(r.respondedAt) - Date.parse(e.createdAt ?? e.ts)) / 1000);
  }
  // Child-side AskUserQuestion outcomes (covers answers that bypassed the event, e.g. send_message).
  let childAskAnswered = 0, childAskCancelled = 0;
  for (const s of sessions) for (const e of s.es) {
    const m = e.message;
    if (m?.role === "toolResult" && m.toolName === "AskUserQuestion" && m.details?.source === "parent_trigger") {
      m.details.cancelled ? childAskCancelled++ : childAskAnswered++;
    }
  }

  const sessionComplete = events.filter((e) => String(e.type).includes("session_complete"));
  // Completion acks that climbed to another agent / pushed the human.
  const completionAgentHops = sessionComplete.filter((e) => (e.deliveries ?? []).length > 1).length;
  const completionHumanPushes = sessionComplete.filter((e) => e.responseContract?.escalate !== false
    && (e.deliveries ?? []).length === 1 && e.deliveries[0].status === "expired").length;

  // Re-ask: escalate_trigger followed by the same session's AskUserQuestion within 3 calls.
  let reasks = 0;
  for (const s of sessions) s.calls.forEach((c: any, i: number) => {
    if (c.name === "escalate_trigger" && s.calls.slice(i + 1, i + 4).some((n: any) => n.name === "AskUserQuestion")) reasks++;
  });

  let cost = 0, tokens = 0;
  for (const s of sessions) for (const e of s.es) {
    const u = e.message?.role === "assistant" ? e.message.usage : null;
    if (u) { cost += u.cost?.total ?? 0; tokens += u.totalTokens ?? ((u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)); }
  }

  // Approval flow (watchman): how the human's answer travelled to the investigator.
  const firstHumanTs = human.map((h) => Date.parse(h.ts ?? "")).filter(Number.isFinite).sort()[0] ?? Infinity;
  const isApproval = (t: string) => /approv/i.test(t) && /push/i.test(t);
  let approvalCopies = 0;
  for (const c of all as any[]) {
    if (Date.parse(c.ts) < firstHumanTs) continue;
    const a = c.arguments ?? {};
    const t = c.name === "send_message" ? a.message : c.name === "respond_to_trigger" ? a.response : null;
    if (t && isApproval(String(t))) approvalCopies++;
  }
  const deepest = sessions.length ? sessions.reduce((b, _, i) => depthOf(i) > depthOf(b) ? i : b, 0) : -1;
  let approvalArrivals = 0; let unblockS: number | null = null;
  if (deepest >= 0) {
    const inv = sessions[deepest];
    const askAt = new Map<string, number>();
    for (const e of inv.es) {
      const m = e.message;
      if (m?.role === "assistant" && Array.isArray(m.content)) for (const c of m.content) if (c?.type === "toolCall" && c.name === "AskUserQuestion") askAt.set(c.id, Date.parse(e.timestamp!));
      if (m?.role === "toolResult" && m.toolName === "AskUserQuestion") {
        const t = textOf(m.content);
        if (/approv|yes/i.test(t) && !m.details?.cancelled) { approvalArrivals++; const s0 = askAt.get(m.toolCallId!); if (s0 && unblockS === null) unblockS = Math.round((Date.parse(e.timestamp!) - s0) / 1000); }
      }
      if (e.type === "custom_message" && isApproval(textOf(e.content))) approvalArrivals++;
    }
  }
  const pushed = (meta.remoteBranches ?? []).some((b: string) => b !== "main") ? 1 : 0;

  const spdx = [...diff.matchAll(/^\+.*SPDX-License-Identifier:\s*(\S+)/gm)].map((m) => m[1]);
  return {
    status: meta.status, testsPass: meta.testsPass ? 1 : 0, wallMin: +(meta.wallMs / 60000).toFixed(1),
    sessions: sessions.length, depth: sessions.length ? Math.max(...sessions.map((_, i) => depthOf(i))) : 0,
    rootMsgs: rootMsgs.length, hubRelays, allRelays,
    sendMessages: all.filter((c: any) => c.name === "send_message").length,
    childAsks: asks.length, askAnsweredByHuman: askHuman, askAnsweredByAgent: askAgent, askOpen,
    askHops, askLatencyMedS: askLat.length ? +median(askLat).toFixed(0) : null,
    childAskAnswered, childAskCancelled,
    humanPrompts: human.length,
    completionAgentHops, completionHumanPushes, reasksAfterEscalate: reasks,
    escalateCalls: all.filter((c: any) => c.name === "escalate_trigger").length,
    licenseCorrect: spdx.length > 0 && spdx.every((x) => x === "BlueOak-1.0.0") ? 1 : 0,
    licenseGuessed: spdx.some((x) => x !== "BlueOak-1.0.0") ? 1 : 0,
    plantedBugFixed: /^-.*slice\(0, n - 1\)/m.test(diff) ? 1 : 0,
    approvalCopies, approvalArrivals, investigatorUnblockS: unblockS, pushed,
    pushedWithoutApproval: pushed && !human.some((h) => /approved/i.test(h.answer)) ? 1 : 0,
    tokensK: Math.round(tokens / 1000), costUsd: +cost.toFixed(2),
  };
}

function median(xs: number[]) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }

const table: Record<string, Record<string, string>> = {};
for (const label of labels) {
  const runDirs = readdirSync(join(root, label)).filter((d) => d.startsWith("run-") && existsSync(join(root, label, d, "meta.json")));
  const scored = runDirs.map((d) => { const s = scoreRun(join(root, label, d)); console.log(label, d, JSON.stringify(s)); return s; });
  if (!scored.length) continue;
  for (const k of Object.keys(scored[0])) {
    const vals = scored.map((s: any) => s[k]);
    const nums = vals.filter((v) => typeof v === "number") as number[];
    (table[k] ??= {})[label] = nums.length === vals.length
      ? `${median(nums)} [${Math.min(...nums)}–${Math.max(...nums)}]`
      : vals.join(",");
  }
}
console.log("\n" + ["metric", ...labels].join(" | "));
for (const [k, row] of Object.entries(table)) console.log([k, ...labels.map((l) => row[l] ?? "-")].join(" | "));
