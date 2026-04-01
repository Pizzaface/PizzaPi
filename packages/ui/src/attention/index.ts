/** Attention system — public API barrel export. */
export type {
  AttentionCategory,
  AttentionItemKind,
  AttentionItem,
  AttentionStoreState,
} from "./types";

export { createAttentionStore, type AttentionStore } from "./store";

export {
  CATEGORY_ORDER,
  needsResponseCount,
  runningCount,
  completedUnreadCount,
  itemsByCategory,
  itemsForSession,
  totalCount,
} from "./selectors";

export {
  normalizeSessionMeta,
  normalizeBackgroundSessionMeta,
  normalizeTriggerHistory,
  type SessionMetaForAttention,
  type BackgroundSessionMetaForAttention,
} from "./normalizers";

export {
  AttentionProvider,
  useAttentionStore,
  useAttentionState,
  useNeedsResponseCount,
  useRunningCount,
  useCompletedUnreadCount,
  useAttentionItemsByCategory,
  useAttentionItemsForSession,
} from "./provider";
