/**
 * Detecting an explicit "present a card" tool call.
 *
 * The read-only sibling of present_artifact: the model chose to hand the user a
 * structured entity (a contact, a place, an event) and it renders as a clean
 * card inline. Pure so the parsing/safety rules are testable without rendering.
 */

import { baseToolName, parseToolInputArgs } from "@/components/session-viewer/utils";

/** Tools whose call IS the model presenting a read-only entity card. */
const PRESENT_CARD_TOOLS: ReadonlySet<string> = new Set([
  "present_card",
  "present-card",
  "presentcard",
  "show_card",
]);

/** URL schemes safe to turn into a clickable action. */
const SAFE_ACTION_SCHEMES = ["https:", "http:", "mailto:", "tel:", "sms:", "geo:"];

export interface PresentedCardField {
  label: string;
  value: string;
}

export interface PresentedCardAction {
  label: string;
  href: string;
  icon?: string;
}

export interface PresentedCard {
  title: string;
  subtitle?: string;
  icon?: string;
  /** Thumbnail / avatar URL (http(s) only). */
  image?: string;
  fields: PresentedCardField[];
  actions: PresentedCardAction[];
}

function toolArgs(toolInput: unknown): Record<string, unknown> {
  if (typeof toolInput === "string") {
    try {
      const parsed = JSON.parse(toolInput);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
    return {};
  }
  return parseToolInputArgs(toolInput);
}

/** A string href is safe when it parses to one of the allowed schemes. */
export function isSafeActionHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  try {
    // Resolve against a base so scheme-relative and relative inputs don't slip
    // through as javascript:/data: — those throw or resolve to http(s).
    const url = new URL(trimmed, "https://pizzapi.invalid/");
    return SAFE_ACTION_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

function isHttpImage(url: string): boolean {
  try {
    const u = new URL(url.trim(), "https://pizzapi.invalid/");
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

function normalizeFields(raw: unknown): PresentedCardField[] {
  if (!Array.isArray(raw)) return [];
  const out: PresentedCardField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const rawValue = rec.value;
    const value = Array.isArray(rawValue)
      ? rawValue.filter((v) => v != null).join(", ")
      : rawValue == null
        ? ""
        : String(rawValue);
    if (!label && !value) continue;
    out.push({ label, value });
  }
  return out;
}

function normalizeActions(raw: unknown): PresentedCardAction[] {
  if (!Array.isArray(raw)) return [];
  const out: PresentedCardAction[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = typeof rec.label === "string" ? rec.label.trim() : "";
    const href = typeof rec.href === "string" ? rec.href.trim() : "";
    if (!label || !href || !isSafeActionHref(href)) continue;
    out.push({ label, href, ...(typeof rec.icon === "string" ? { icon: rec.icon } : {}) });
  }
  return out;
}

/** The card a tool call is presenting, or null. */
export function detectPresentedCard(toolName: string | undefined, toolInput: unknown): PresentedCard | null {
  const base = baseToolName(toolName);
  if (!base || !PRESENT_CARD_TOOLS.has(base)) return null;

  const args = toolArgs(toolInput);
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title) return null;

  const image = typeof args.image === "string" && isHttpImage(args.image) ? args.image.trim() : undefined;

  return {
    title,
    subtitle: typeof args.subtitle === "string" && args.subtitle.trim() ? args.subtitle.trim() : undefined,
    icon: typeof args.icon === "string" && args.icon.trim() ? args.icon.trim() : undefined,
    ...(image ? { image } : {}),
    fields: normalizeFields(args.fields),
    actions: normalizeActions(args.actions),
  };
}
