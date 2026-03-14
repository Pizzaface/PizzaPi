/**
 * Session tree builder — organizes flat session list into parent-child tree structure.
 */

export interface HubSession {
  sessionId: string;
  shareUrl: string;
  cwd: string;
  startedAt: string;
  viewerCount?: number;
  userId?: string;
  userName?: string;
  sessionName?: string | null;
  isEphemeral?: boolean;
  expiresAt?: string | null;
  isActive?: boolean;
  lastHeartbeatAt?: string | null;
  model?: { provider: string; id: string; name?: string } | null;
  runnerId?: string | null;
  runnerName?: string | null;
  isPinned?: boolean;
  parentSessionId?: string | null;
}

export interface SessionTreeNode {
  session: HubSession;
  children: SessionTreeNode[];
}

/**
 * Build a hierarchical tree of sessions from a flat list.
 * Returns only root sessions (no parent). Children are nested in the tree.
 */
export function buildSessionTree(sessions: HubSession[]): SessionTreeNode[] {
  // Create a map for quick lookup
  const sessionMap = new Map<string, HubSession>();
  for (const session of sessions) {
    sessionMap.set(session.sessionId, session);
  }

  // Create tree nodes
  const nodeMap = new Map<string, SessionTreeNode>();
  for (const session of sessions) {
    nodeMap.set(session.sessionId, { session, children: [] });
  }

  // Build parent-child relationships
  for (const session of sessions) {
    if (session.parentSessionId) {
      const parentNode = nodeMap.get(session.parentSessionId);
      const childNode = nodeMap.get(session.sessionId);
      if (parentNode && childNode) {
        // Sort children by start time (oldest first)
        parentNode.children.push(childNode);
      }
    }
  }

  // Sort children by startedAt
  for (const node of nodeMap.values()) {
    node.children.sort((a, b) => {
      const aTime = new Date(a.session.startedAt).getTime();
      const bTime = new Date(b.session.startedAt).getTime();
      return aTime - bTime;
    });
  }

  // Return root sessions: those with no parent, or whose parent is not in this subset
  const roots: SessionTreeNode[] = [];
  for (const session of sessions) {
    if (!session.parentSessionId || !nodeMap.has(session.parentSessionId)) {
      const node = nodeMap.get(session.sessionId);
      if (node) roots.push(node);
    }
  }

  // Sort roots by start time (newest first for recency)
  roots.sort((a, b) => {
    const aTime = new Date(a.session.startedAt).getTime();
    const bTime = new Date(b.session.startedAt).getTime();
    return bTime - aTime;
  });

  return roots;
}

/**
 * Flatten a tree back to a list, preserving parent-child relationships.
 * Used for rendering in order with depth information.
 */
export interface FlattenedSession {
  session: HubSession;
  depth: number;
  isExpanded: boolean; // Provided by caller
}

export function flattenSessionTree(
  roots: SessionTreeNode[],
  expandedNodeIds: Set<string>
): FlattenedSession[] {
  const result: FlattenedSession[] = [];

  function traverse(node: SessionTreeNode, depth: number) {
    const isExpanded = expandedNodeIds.has(node.session.sessionId);
    result.push({ session: node.session, depth, isExpanded });

    if (isExpanded && node.children.length > 0) {
      for (const child of node.children) {
        traverse(child, depth + 1);
      }
    }
  }

  for (const root of roots) {
    traverse(root, 0);
  }

  return result;
}

/**
 * Get the display indent for a session at a given depth.
 * Returns px value for CSS margin-left.
 */
export function getSessionIndent(depth: number): number {
  // First level (roots) have no indent
  // Each child adds 16px (similar to tree indentation)
  return depth > 0 ? depth * 16 : 0;
}

/**
 * Get all descendant session IDs for a given session (children, grandchildren, etc.).
 * Searches through the flat sessions list by following parentSessionId references.
 */
export function getDescendantSessionIds(
  sessionId: string,
  sessions: HubSession[],
): string[] {
  const result: string[] = [];
  const visited = new Set<string>([sessionId]);
  const queue = [sessionId];
  while (queue.length > 0) {
    const parentId = queue.shift()!;
    for (const s of sessions) {
      if (s.parentSessionId === parentId && !visited.has(s.sessionId)) {
        visited.add(s.sessionId);
        result.push(s.sessionId);
        queue.push(s.sessionId);
      }
    }
  }
  return result;
}
