/**
 * Pure logic for building session topology trees.
 * Extracted from the SessionTopology component so it can be tested independently.
 */

/** Minimal session shape needed for tree building */
export interface TopologySession {
  sessionId: string;
  parentSessionId?: string | null;
  childSessionIds?: string[];
}

export interface TreeNode<T extends TopologySession> {
  session: T;
  children: TreeNode<T>[];
}

/**
 * Build a tree of sessions rooted at the given session's family tree.
 * Returns the root(s) of the tree that contain `currentSessionId`.
 *
 * Returns an empty array when the current session has no parent or children,
 * keeping the UI clean for single-agent workflows.
 */
export function buildSessionTree<T extends TopologySession>(
  currentSessionId: string,
  sessions: T[],
): TreeNode<T>[] {
  const byId = new Map<string, T>();
  for (const s of sessions) {
    byId.set(s.sessionId, s);
  }

  const current = byId.get(currentSessionId);
  if (!current) return [];

  // Walk up to find the root of the family
  let root = current;
  const visited = new Set<string>();
  while (root.parentSessionId && byId.has(root.parentSessionId)) {
    if (visited.has(root.sessionId)) break; // cycle guard
    visited.add(root.sessionId);
    root = byId.get(root.parentSessionId)!;
  }

  // Build tree recursively from root
  function buildNode(session: T, depth: number): TreeNode<T> {
    const childIds = session.childSessionIds ?? [];
    const children: TreeNode<T>[] = [];
    if (depth < 10) {
      // depth guard
      for (const childId of childIds) {
        const child = byId.get(childId);
        if (child) {
          children.push(buildNode(child, depth + 1));
        }
      }
    }
    return { session, children };
  }

  const tree = buildNode(root, 0);

  // Only return a tree if it has more than just the current session
  const hasFamily =
    (current.parentSessionId && byId.has(current.parentSessionId)) ||
    (current.childSessionIds && current.childSessionIds.length > 0);

  if (!hasFamily) return [];

  return [tree];
}
