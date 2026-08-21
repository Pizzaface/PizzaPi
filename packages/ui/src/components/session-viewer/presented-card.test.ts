import { describe, test, expect } from "bun:test";
import { detectPresentedCard, detectPresentedCards, isSafeActionHref, schemaKind, formatAddress, isExternalImage } from "./presented-card";

const present = (entity: unknown) => detectPresentedCard("present_card", { entity });

describe("isExternalImage", () => {
  test("returns true for http and https URLs", () => {
    expect(isExternalImage("https://example.com/img.jpg")).toBe(true);
    expect(isExternalImage("http://attacker.com/track.gif")).toBe(true);
  });
  test("returns false for non-http schemes and invalid input", () => {
    expect(isExternalImage("data:image/png;base64,abc")).toBe(false);
    expect(isExternalImage("/relative/path.jpg")).toBe(false);
    expect(isExternalImage("")).toBe(false);
    expect(isExternalImage("javascript:alert(1)")).toBe(false);
  });
  test("treats protocol-relative URLs as external (C-006 bypass fix)", () => {
    expect(isExternalImage("//attacker.example/track.gif")).toBe(true);
    expect(isExternalImage("//host/x")).toBe(true);
  });
  test("treats uppercase schemes as external", () => {
    expect(isExternalImage("HTTP://host/img.jpg")).toBe(true);
    expect(isExternalImage("HTTPS://host/img.jpg")).toBe(true);
  });
  test("same-origin relative paths are not external", () => {
    expect(isExternalImage("/assets/img.png")).toBe(false);
    expect(isExternalImage("./img.png")).toBe(false);
  });
  test("data: URLs (with any case) are not external", () => {
    expect(isExternalImage("DATA:image/png;base64,abc")).toBe(false);
  });
});

describe("isSafeActionHref", () => {
  test("allows tel/mailto/sms/geo/http(s)", () => {
    for (const h of ["tel:+15551234567", "mailto:a@b.com", "sms:+1555", "geo:37.1,-122.1", "https://x.com", "http://x.com/p"]) {
      expect(isSafeActionHref(h)).toBe(true);
    }
  });
  test("rejects javascript/data/file and empty", () => {
    for (const h of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "  "]) {
      expect(isSafeActionHref(h)).toBe(false);
    }
  });
});

describe("schemaKind taxonomy", () => {
  test("maps schema.org types to card kinds", () => {
    expect(schemaKind("Person")).toBe("person");
    expect(schemaKind("LocalBusiness")).toBe("business");
    expect(schemaKind("Restaurant")).toBe("business");
    expect(schemaKind("Plumber")).toBe("generic"); // unknown subtype; upgraded to business by signals in normalizeSchemaEntity
    expect(schemaKind("HomeAndConstructionBusiness")).toBe("business");
    expect(schemaKind("Place")).toBe("place");
    expect(schemaKind("TouristAttraction")).toBe("place");
    expect(schemaKind("MusicEvent")).toBe("event");
    expect(schemaKind("Product")).toBe("product");
    expect(schemaKind("Offer")).toBe("product");
    expect(schemaKind("http://schema.org/Person")).toBe("person");
    expect(schemaKind(["Person", "Thing"])).toBe("person");
    expect(schemaKind("Thing")).toBe("generic");
    expect(schemaKind(undefined)).toBe("generic");
  });
});

describe("formatAddress", () => {
  test("joins PostalAddress parts", () => {
    expect(formatAddress({ streetAddress: "1 Main St", addressLocality: "Springfield", addressRegion: "IL", postalCode: "62704" }))
      .toBe("1 Main St, Springfield, IL, 62704");
  });
  test("passes a string address through", () => {
    expect(formatAddress("123 Elm")).toBe("123 Elm");
  });
});

describe("detectPresentedCard — schema.org entities", () => {
  test("ignores non-present tools", () => {
    expect(detectPresentedCard("bash", { entity: { name: "x" } })).toBeNull();
  });

  test("requires a title/name", () => {
    expect(present({ "@type": "Person", jobTitle: "nobody" })).toBeNull();
  });

  test("LocalBusiness: rating, directions, call, website", () => {
    const card = present({
      "@type": "LocalBusiness",
      name: "Bob's Handyman",
      description: "Factory-authorized appliance repair serving the tri-cities.",
      telephone: "(555) 123-4567",
      url: "https://bobs.example",
      address: { streetAddress: "1 Main St", addressLocality: "Springfield" },
      aggregateRating: { ratingValue: 4.5, reviewCount: 87, bestRating: 5 },
      priceRange: "$$",
    })!;
    expect(card.kind).toBe("business");
    expect(card.title).toBe("Bob's Handyman");
    expect(card.rating).toEqual({ value: 4.5, max: 5, count: 87 });
    expect(card.price).toBe("$$");
    expect(card.address).toBe("1 Main St, Springfield");
    // The long description is its own block, never the subtitle.
    expect(card.description).toBe("Factory-authorized appliance repair serving the tri-cities.");
    expect(card.subtitle).toBeUndefined();
    // Address is not duplicated as a generic field.
    expect(card.fields.find((f) => f.label === "Address")).toBeUndefined();
    const labels = card.actions.map((a) => a.label);
    expect(labels).toContain("Call");
    expect(labels).toContain("Website");
    expect(labels).toContain("Directions");
    expect(card.actions.find((a) => a.label === "Call")?.href).toBe("tel:5551234567");
    // Directions searches by name + address, not just the city.
    const dir = card.actions.find((a) => a.label === "Directions")!.href;
    expect(dir).toContain("Bob");
    expect(dir).toContain("Springfield");
  });

  test("directions use name + city when only a city-level address is given", () => {
    const card = present({ "@type": "LocalBusiness", name: "American Appliance", address: "Bristol, TN", telephone: "555-1" })!;
    const dir = card.actions.find((a) => a.label === "Directions")!.href;
    expect(decodeURIComponent(dir)).toContain("American Appliance, Bristol, TN");
  });

  test("Person: subtitle from jobTitle, call/email actions", () => {
    const card = present({ "@type": "Person", name: "Ada Lovelace", jobTitle: "Mathematician", telephone: "555-0100", email: "ada@x.com" })!;
    expect(card.kind).toBe("person");
    expect(card.subtitle).toBe("Mathematician");
    expect(card.actions.map((a) => a.label)).toEqual(expect.arrayContaining(["Call", "Email"]));
    expect(card.actions.find((a) => a.label === "Email")?.href).toBe("mailto:ada@x.com");
  });

  test("Event: dates and location", () => {
    const card = present({ "@type": "MusicEvent", name: "Jazz Night", startDate: "2026-09-01", location: { name: "Blue Note" } })!;
    expect(card.kind).toBe("event");
    expect(card.fields.find((f) => f.label === "Where")?.value).toBe("Blue Note");
    expect(card.fields.find((f) => f.label === "Starts")?.value).toBeTruthy();
  });

  test("Product: price from offers, View action", () => {
    const card = present({ "@type": "Product", name: "Drill", offers: { price: "49.99", priceCurrency: "USD", url: "https://shop.example/drill" } })!;
    expect(card.kind).toBe("product");
    expect(card.price).toBe("$49.99");
    expect(card.actions.find((a) => a.label === "View")?.href).toBe("https://shop.example/drill");
  });

  test("Place with geo yields a lat,lng directions link", () => {
    const card = present({ "@type": "Place", name: "Overlook", geo: { latitude: 37.1, longitude: -122.2 } })!;
    expect(card.kind).toBe("place");
    expect(card.actions.find((a) => a.label === "Directions")?.href).toContain("37.1%2C-122.2");
  });

  test("unknown business subtype is inferred from address + phone signals", () => {
    const card = present({ "@type": "Plumber", name: "Ace Plumbing", telephone: "555-0000", address: "9 Pipe Ln" })!;
    expect(card.kind).toBe("business");
    expect(card.actions.map((a) => a.label)).toContain("Directions");
  });

  test("unsafe action hrefs and images are dropped", () => {
    const card = present({
      "@type": "Organization",
      name: "Evil Co",
      image: "javascript:1",
      actions: [{ label: "Bad", href: "javascript:alert(1)" }, { label: "Site", href: "https://ok.example" }],
    })!;
    expect(card.image).toBeUndefined();
    expect(card.actions.map((a) => a.label)).toContain("Site");
    expect(card.actions.map((a) => a.label)).not.toContain("Bad");
  });

  test("legacy flat shape (no entity wrapper, no @type) still renders", () => {
    const card = detectPresentedCard("present_card", {
      title: "Plain Card",
      fields: [{ label: "Note", value: "hi" }],
      actions: [{ label: "Open", href: "https://x.com" }],
    })!;
    expect(card.kind).toBe("generic");
    expect(card.title).toBe("Plain Card");
    expect(card.fields).toContainEqual({ label: "Note", value: "hi" });
    expect(card.actions).toContainEqual({ label: "Open", href: "https://x.com" });
  });

  test("recognizes the MCP-prefixed form and JSON-string input", () => {
    expect(detectPresentedCard("mcp__pizzawork__present_card", { entity: { name: "Prefixed" } })?.title).toBe("Prefixed");
    expect(detectPresentedCard("present_card", JSON.stringify({ entity: { name: "Stringy" } }))?.title).toBe("Stringy");
  });
});

describe("detectPresentedCards - one or many", () => {
  test("non-present tool yields no cards", () => {
    expect(detectPresentedCards("bash", { entities: [{ name: "x" }] })).toEqual([]);
  });

  test("a single entity yields one card", () => {
    const cards = detectPresentedCards("present_card", { entity: { "@type": "Person", name: "Ada" } });
    expect(cards.map((c) => c.title)).toEqual(["Ada"]);
  });

  test("an entities array yields many, preserving order and dropping untitled", () => {
    const cards = detectPresentedCards("present_card", {
      entities: [
        { "@type": "LocalBusiness", name: "Alpha" },
        { "@type": "LocalBusiness" },
        { "@type": "LocalBusiness", name: "Bravo" },
      ],
    });
    expect(cards.map((c) => c.title)).toEqual(["Alpha", "Bravo"]);
  });

  test("entity given as an array is also accepted", () => {
    const cards = detectPresentedCards("present_card", { entity: [{ name: "One" }, { name: "Two" }] });
    expect(cards.map((c) => c.title)).toEqual(["One", "Two"]);
  });

  test("detectPresentedCard returns the first of many", () => {
    expect(detectPresentedCard("present_card", { entities: [{ name: "First" }, { name: "Second" }] })?.title).toBe("First");
  });
});
