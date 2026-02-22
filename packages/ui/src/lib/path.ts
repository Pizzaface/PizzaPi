export function formatPathTail(path: string, maxSegments = 2): string {
  if (!path) return "";
  const normalized = path.replace(/\\/g, "/");
  const driveMatch = normalized.match(/^[A-Za-z]:/);

  let prefix = "";
  let rest = normalized;

  if (driveMatch) {
    prefix = driveMatch[0];
    rest = normalized.slice(prefix.length);
  } else if (normalized.startsWith("/")) {
    prefix = "/";
    rest = normalized.slice(1);
  }

  const parts = rest.split("/").filter(Boolean);
  if (parts.length === 0) return normalized;
  if (parts.length === 1) return normalized;

  const segmentsToShow = Math.min(maxSegments, Math.max(1, parts.length - 1));
  const tail = parts.slice(-segmentsToShow).join("/");

  if (driveMatch) return `${prefix}/…/${tail}`;
  if (prefix) return `${prefix}…/${tail}`;
  return `…/${tail}`;
}
