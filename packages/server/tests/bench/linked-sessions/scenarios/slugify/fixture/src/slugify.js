export function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Shorten text to at most n characters.
export function truncate(text, n) {
  return text.length > n ? text.slice(0, n - 1) : text;
}
