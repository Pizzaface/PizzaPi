import type { TodoItem } from "@/lib/types";
import type { MetaGoalStatus } from "@pizzapi/protocol";
import {
  normalizeCommandList,
  normalizeModel,
  normalizeModelList,
  normalizeSessionName,
} from "./message-helpers";

export interface SessionMetadataUpdatePatch {
  activeModel?: { provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number } | null;
  availableModels?: Array<{ provider: string; id: string; name?: string; reasoning?: boolean; contextWindow?: number }>;
  availableCommands?: Array<{ name: string; description?: string; source?: string }>;
  sessionName?: string | null;
  thinkingLevel?: string | null;
  todoList?: TodoItem[];
  goal?: MetaGoalStatus | null;
  /** Pending follow-up texts reported by the runner (authoritative queue). */
  queuedMessages?: string[];
}

export function deriveSessionMetadataUpdatePatch(input: {
  metadata: Record<string, unknown>;
  hubAuthoritative?: boolean;
  currentActiveModel?: SessionMetadataUpdatePatch["activeModel"];
}): SessionMetadataUpdatePatch {
  const { metadata, currentActiveModel } = input;
  const patch: SessionMetadataUpdatePatch = {};

  if (Object.prototype.hasOwnProperty.call(metadata, "availableModels") && Array.isArray(metadata.availableModels)) {
    patch.availableModels = normalizeModelList(metadata.availableModels as unknown[]);
  }

  if (Object.prototype.hasOwnProperty.call(metadata, "availableCommands") && Array.isArray(metadata.availableCommands)) {
    patch.availableCommands = normalizeCommandList(metadata.availableCommands as unknown[]);
  }

  if (Object.prototype.hasOwnProperty.call(metadata, "model")) {
    const nextModel = normalizeModel(metadata.model);
    if (
      nextModel &&
      currentActiveModel &&
      currentActiveModel.provider === nextModel.provider &&
      currentActiveModel.id === nextModel.id
    ) {
      patch.activeModel = {
        ...currentActiveModel,
        ...Object.fromEntries(Object.entries(nextModel).filter(([, value]) => value !== undefined)),
      };
    } else {
      patch.activeModel = nextModel;
    }
  }

  if (Object.prototype.hasOwnProperty.call(metadata, "sessionName")) {
    patch.sessionName = normalizeSessionName(metadata.sessionName);
  }

  if (Object.prototype.hasOwnProperty.call(metadata, "thinkingLevel")) {
    patch.thinkingLevel = typeof metadata.thinkingLevel === "string" ? metadata.thinkingLevel : null;
  }

  if (Array.isArray(metadata.todoList)) {
    patch.todoList = metadata.todoList as TodoItem[];
  }

  if (Array.isArray(metadata.queuedMessages)) {
    patch.queuedMessages = (metadata.queuedMessages as unknown[]).filter(
      (m): m is string => typeof m === "string",
    );
  }

  if (Object.prototype.hasOwnProperty.call(metadata, "goal")) {
    const rawGoal = metadata.goal;
    if (rawGoal && typeof rawGoal === "object" && "id" in rawGoal && "status" in rawGoal) {
      patch.goal = rawGoal as MetaGoalStatus;
    } else {
      patch.goal = null;
    }
  }

  return patch;
}
