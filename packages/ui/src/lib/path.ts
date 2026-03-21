/**
 * Extract the worktree name from a cwd that contains `/.worktrees/`.
 *
 * Because branch names can contain slashes (e.g. `feat/login`), we can't just
 * split on `/` and take the first segment. Instead, we walk up from the full
 * path after the marker, checking each prefix against a set of known worktree
 * roots (typically other sessions' cwds). The longest matching root wins.
 *
 * If no known roots match, falls back to the first path segment after the
 * marker (best-effort for single-segment branch names).
 *
 * @param cwd              The session's current working directory
 * @param knownWorktreeCwds Set/array of cwds from other sessions that may be
 *                          worktree roots (paths ending right at the worktree
 *                          directory, e.g. `/repo/.worktrees/feat/login`)
 * @returns The worktree/branch name, or null if cwd doesn't contain the marker
 */
export function extractWorktreeName(
  cwd: string,
  knownWorktreeCwds: Iterable<string> = [],
): string | null {
  const marker = "/.worktrees/";
  const idx = cwd.indexOf(marker);
  if (idx === -1) return null;

  const repoRoot = cwd.substring(0, idx);
  const afterMarker = cwd.substring(idx + marker.length).replace(/\/$/, "");
  if (!afterMarker) return null;

  // Check known cwds to find the longest worktree root that is a prefix of our cwd.
  // The worktree name is the part between the marker and the root.
  let bestName: string | null = null;
  for (const other of knownWorktreeCwds) {
    // A known worktree root must start with `<repoRoot>/.worktrees/`
    if (!other.startsWith(repoRoot + marker)) continue;
    const otherAfterMarker = other.substring(idx + marker.length).replace(/\/$/, "");
    if (!otherAfterMarker) continue;
    // The known cwd must be a prefix of (or equal to) our afterMarker path
    if (afterMarker === otherAfterMarker || afterMarker.startsWith(otherAfterMarker + "/")) {
      if (!bestName || otherAfterMarker.length > bestName.length) {
        bestName = otherAfterMarker;
      }
    }
  }

  if (bestName) return bestName;

  // Fallback: first path segment (works for single-segment branch names)
  const firstSlash = afterMarker.indexOf("/");
  return firstSlash === -1 ? afterMarker : afterMarker.substring(0, firstSlash);
}

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
