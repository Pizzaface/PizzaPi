/**
 * Detecting an explicit "present a card" tool call and normalizing a
 * schema.org entity into a unified display model.
 *
 * The model returns a schema.org JSON-LD entity (a format it already knows);
 * the host maps `@type` to a tailored card — a Person gets a call/email row, a
 * LocalBusiness gets a rating + directions, an Event gets its dates, etc. Pure
 * so the taxonomy and safety rules are testable without rendering.
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

/** Fixed origin used to distinguish same-origin paths from outbound image URLs. */
const IMAGE_BASE_URL = new URL("https://pizzapi.invalid/");
const TRUSTED_IMAGE_ORIGINS = new Set([IMAGE_BASE_URL.origin]);

/** The unified card kinds the taxonomy collapses schema.org types into. */
export type CardKind = "person" | "business" | "place" | "event" | "product" | "generic";

export interface PresentedCardField {
  label: string;
  value: string;
}

export interface PresentedCardAction {
  label: string;
  href: string;
  icon?: string;
}

export interface CardRating {
  value: number;
  max: number;
  count?: number;
}

/** Normalized, render-ready card — one shape for every schema.org type. */
export interface PresentedCard {
  kind: CardKind;
  /** schema.org @type as given, for reference/testing. */
  schemaType?: string;
  title: string;
  subtitle?: string;
  /** Longer prose (schema.org description), shown as a clamped block. */
  description?: string;
  image?: string;
  /** Default Lucide icon for the kind, overridable by the entity. */
  icon: string;
  rating?: CardRating;
  price?: string;
  address?: string;
  geo?: { lat: number; lng: number };
  /** Short chips (category, opening hours summary, event date…). */
  badges: string[];
  fields: PresentedCardField[];
  actions: PresentedCardAction[];
}

const KIND_ICON: Record<CardKind, string> = {
  person: "user",
  business: "store",
  place: "map-pin",
  event: "calendar",
  product: "tag",
  generic: "info",
};

// ── low-level helpers ────────────────────────────────────────────────────────

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

function str(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.filter((v) => v != null).map((v) => str(v)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    return typeof name === "string" ? name.trim() : "";
  }
  return String(value).trim();
}

function firstString(...values: unknown[]): string {
  for (const v of values) {
    const s = str(v);
    if (s) return s;
  }
  return "";
}

export function isSafeActionHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed, "https://pizzapi.invalid/");
    return SAFE_ACTION_SCHEMES.includes(url.protocol);
  } catch {
    return false;
  }
}

/**
 * Returns true for any image URL that will (or could) cause an outbound
 * network request. These must be gated behind an explicit user action.
 *
 * Fail-closed: when in doubt, classify as external. A false-positive is a
 * click-to-load prompt (harmless); a false-negative is a privacy leak.
 *
 * Safe (non-external): data: URLs and paths that resolve against the trusted
 * base origin. External: http(s) URLs whose browser-resolved origin differs.
 */
export function isExternalImage(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  // data: URLs are self-contained — not external.
  if (/^data:/i.test(trimmed)) return false;
  try {
    const resolved = new URL(trimmed, IMAGE_BASE_URL);
    return (resolved.protocol === "http:" || resolved.protocol === "https:")
      && !TRUSTED_IMAGE_ORIGINS.has(resolved.origin);
  } catch {
    return false;
  }
}

function httpImage(value: unknown): string | undefined {
  const raw = Array.isArray(value) ? value[0] : value;
  const url = typeof raw === "string" ? raw.trim() : str(raw);
  if (!url) return undefined;
  try {
    const resolved = new URL(url, IMAGE_BASE_URL);
    return resolved.protocol === "https:" || resolved.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

/** Bare schema.org type name, lowercased, URL prefix stripped, first of a list. */
function typeName(rawType: unknown): string {
  const t = Array.isArray(rawType) ? rawType[0] : rawType;
  if (typeof t !== "string") return "";
  return t.replace(/^https?:\/\/schema\.org\//i, "").trim().toLowerCase();
}

const BUSINESS_TYPES = new Set([
  "organization", "localbusiness", "restaurant", "store", "cafe", "bar", "hotel",
  "lodgingbusiness", "foodestablishment", "professionalservice", "corporation",
  "company", "medicalbusiness", "financialservice", "homeandconstructionbusiness",
  "automotivebusiness", "healthandbeautybusiness",
]);
const PLACE_TYPES = new Set([
  "place", "postaladdress", "geocoordinates", "touristattraction", "landmarksorhistoricalbuildings",
  "civicstructure", "accommodation", "administrativearea", "city",
]);
const PRODUCT_TYPES = new Set(["product", "individualproduct", "offer", "aggregateoffer"]);
const PERSON_TYPES = new Set(["person", "contactpoint"]);

export function schemaKind(rawType: unknown): CardKind {
  const t = typeName(rawType);
  if (!t) return "generic";
  if (PERSON_TYPES.has(t)) return "person";
  if (PRODUCT_TYPES.has(t)) return "product";
  if (t.endsWith("event")) return "event";
  if (BUSINESS_TYPES.has(t) || t.endsWith("business")) return "business";
  if (PLACE_TYPES.has(t)) return "place";
  return "generic";
}

// ── property extractors ──────────────────────────────────────────────────────

/** Format a schema.org PostalAddress (object or string) into one line. */
export function formatAddress(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!value || typeof value !== "object") return "";
  const a = value as Record<string, unknown>;
  const parts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry]
    .map((p) => str(p))
    .filter(Boolean);
  return parts.join(", ");
}

function parseGeo(value: unknown): { lat: number; lng: number } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const g = value as Record<string, unknown>;
  const lat = Number(g.latitude ?? g.lat);
  const lng = Number(g.longitude ?? g.lng ?? g.lon);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  return undefined;
}

function parseRating(entity: Record<string, unknown>): CardRating | undefined {
  const agg = entity.aggregateRating;
  const src = agg && typeof agg === "object" ? (agg as Record<string, unknown>) : entity;
  const value = Number(src.ratingValue ?? (src === entity ? undefined : src.ratingValue));
  if (!Number.isFinite(value)) return undefined;
  const max = Number(src.bestRating);
  const count = Number(src.reviewCount ?? src.ratingCount);
  return {
    value,
    max: Number.isFinite(max) && max > 0 ? max : 5,
    ...(Number.isFinite(count) && count > 0 ? { count } : {}),
  };
}

function parsePrice(entity: Record<string, unknown>): string {
  const range = str(entity.priceRange);
  if (range) return range;
  const offer = entity.offers && typeof entity.offers === "object" ? (entity.offers as Record<string, unknown>) : entity;
  const price = offer.price ?? offer.lowPrice;
  if (price == null || price === "") return "";
  const currency = str(offer.priceCurrency);
  const symbol = { USD: "$", EUR: "€", GBP: "£", JPY: "¥" }[currency] ?? "";
  return symbol ? `${symbol}${price}` : currency ? `${price} ${currency}` : String(price);
}

/**
 * Directions link for a place, key-free via a Google Maps query.
 *
 * Prefer the name + address so Maps lands on the actual business listing
 * ("American Appliance, Bristol, TN") rather than dropping a pin on the city
 * centroid. Falls back to precise geo coordinates only when there's no name or
 * address to search by.
 */
function directionsHref(name: string, address: string, geo?: { lat: number; lng: number }): string | undefined {
  // With an address, search by name + address so Maps finds the listing.
  // Without one, precise geo coordinates beat an ambiguous bare name.
  const query = address
    ? [name, address].map((p) => p.trim()).filter(Boolean).join(", ")
    : geo
      ? `${geo.lat},${geo.lng}`
      : name.trim();
  if (!query) return undefined;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function telHref(value: unknown): string | undefined {
  const phone = str(value);
  if (!phone) return undefined;
  const cleaned = phone.replace(/[^\d+]/g, "");
  return cleaned.length >= 3 ? `tel:${cleaned}` : undefined;
}

// ── explicit field/action passthrough (legacy + author overrides) ────────────

function normalizeFields(raw: unknown): PresentedCardField[] {
  if (!Array.isArray(raw)) return [];
  const out: PresentedCardField[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const label = str(rec.label ?? rec.name);
    const value = str(rec.value);
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
    const label = str(rec.label ?? rec.name);
    const href = typeof rec.href === "string" ? rec.href.trim() : typeof rec.url === "string" ? rec.url.trim() : "";
    if (!label || !href || !isSafeActionHref(href)) continue;
    out.push({ label, href, ...(typeof rec.icon === "string" ? { icon: rec.icon } : {}) });
  }
  return out;
}

function pushAction(actions: PresentedCardAction[], action: PresentedCardAction | undefined) {
  if (!action) return;
  if (actions.some((a) => a.href === action.href)) return;
  actions.push(action);
}

// ── the normalizer ───────────────────────────────────────────────────────────

/**
 * Turn a schema.org entity (or the legacy flat shape) into a render-ready card.
 * Returns null when there is nothing to title the card with.
 */
export function normalizeSchemaEntity(raw: unknown): PresentedCard | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entity = raw as Record<string, unknown>;

  const schemaType = entity["@type"] ?? entity.type;
  let kind = schemaKind(schemaType);

  const address = formatAddress(entity.address ?? (schemaKind(schemaType) === "place" ? entity : undefined));
  const title = firstString(entity.name, entity.title, entity.headline, address);
  if (!title) return null;

  const geo = parseGeo(entity.geo ?? entity.geoCoordinates);
  const rating = parseRating(entity);
  const price = parsePrice(entity);

  // Unknown schema.org type but clearly a place of business: schema.org has
  // hundreds of LocalBusiness subtypes we don't enumerate, so infer from signals.
  if (kind === "generic" && address && (str(entity.telephone) || rating || price || entity.openingHours)) {
    kind = "business";
  }
  const image = httpImage(entity.image ?? entity.photo ?? entity.logo ?? entity.thumbnailUrl);

  const description = str(entity.description);

  // Subtitle: a SHORT one-liner per kind — never the long description, which
  // gets its own clamped block.
  const subtitle = firstString(
    kind === "person" ? entity.jobTitle : undefined,
    kind === "person" ? (entity.worksFor as Record<string, unknown> | undefined)?.name : undefined,
    kind === "product" ? (entity.brand as Record<string, unknown> | undefined)?.name ?? entity.brand : undefined,
    kind === "business" ? (entity.category ?? entity.servesCuisine) : undefined,
  );

  const badges: string[] = [];
  if (price) badges.push(price);
  const hours = entity.openingHours;
  if (typeof hours === "string" && hours.trim()) badges.push(hours.trim());
  else if (Array.isArray(hours) && hours.length > 0) badges.push(hours.map((h) => str(h)).filter(Boolean).join("; "));

  // Type-specific fields.
  const fields: PresentedCardField[] = [];
  const addField = (label: string, value: unknown) => {
    const v = str(value);
    if (v) fields.push({ label, value: v });
  };
  // Address renders on its own line (with a pin); phone/email become Call/Email
  // actions — so neither is repeated here.
  if (kind === "event") {
    addField("Starts", formatDate(entity.startDate));
    addField("Ends", formatDate(entity.endDate));
    addField("Where", firstString((entity.location as Record<string, unknown> | undefined)?.name, formatAddress(entity.location)));
  }
  // Author-supplied extra fields always win a spot.
  fields.push(...normalizeFields(entity.fields));

  // Derived + explicit actions.
  const actions: PresentedCardAction[] = [];
  pushAction(actions, telHref(entity.telephone) ? { label: "Call", href: telHref(entity.telephone)!, icon: "phone" } : undefined);
  const email = str(entity.email);
  pushAction(actions, email ? { label: "Email", href: `mailto:${email}`, icon: "mail" } : undefined);
  const offersObj = entity.offers && typeof entity.offers === "object" && !Array.isArray(entity.offers)
    ? (entity.offers as Record<string, unknown>)
    : undefined;
  const url = firstString(entity.url, offersObj?.url, Array.isArray(entity.sameAs) ? entity.sameAs[0] : entity.sameAs);
  if (url && isSafeActionHref(url)) {
    pushAction(actions, { label: kind === "product" ? "View" : "Website", href: url, icon: kind === "product" ? "external-link" : "globe" });
  }
  const dir = (kind === "place" || kind === "business" || address || geo)
    ? directionsHref(title, address, geo)
    : undefined;
  pushAction(actions, dir ? { label: "Directions", href: dir, icon: "map-pin" } : undefined);
  for (const a of normalizeActions(entity.actions)) pushAction(actions, a);

  return {
    kind,
    schemaType: typeof schemaType === "string" ? schemaType : undefined,
    title,
    subtitle: subtitle || undefined,
    description: description || undefined,
    image,
    icon: firstString(entity.icon) || KIND_ICON[kind],
    rating,
    price: price || undefined,
    address: address || undefined,
    geo,
    badges,
    fields,
    actions,
  };
}

function formatDate(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  const hasTime = /\d{2}:\d{2}/.test(s);
  return d.toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    ...(hasTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

/**
 * The entities a present_card call is showing, in order.
 *
 * Accepts one or many: an `entities`/`cards`/`items` array, a single `entity`
 * (object or array), or — for the legacy flat shape — the args themselves.
 */
function pickEntities(args: Record<string, unknown>): unknown[] {
  for (const key of ["entities", "cards", "items"]) {
    if (Array.isArray(args[key])) return args[key] as unknown[];
  }
  const entity = args.entity;
  if (Array.isArray(entity)) return entity;
  if (entity && typeof entity === "object") return [entity];
  return [args];
}

/** Every card a tool call is presenting (0, 1, or many). */
export function detectPresentedCards(toolName: string | undefined, toolInput: unknown): PresentedCard[] {
  const base = baseToolName(toolName);
  if (!base || !PRESENT_CARD_TOOLS.has(base)) return [];

  const args = toolArgs(toolInput);
  const cards: PresentedCard[] = [];
  for (const entity of pickEntities(args)) {
    const card = normalizeSchemaEntity(entity);
    if (card) cards.push(card);
  }
  return cards;
}

/** The first card a tool call is presenting, or null. */
export function detectPresentedCard(toolName: string | undefined, toolInput: unknown): PresentedCard | null {
  return detectPresentedCards(toolName, toolInput)[0] ?? null;
}
