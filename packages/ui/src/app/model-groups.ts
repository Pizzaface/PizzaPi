import { modelKey } from "@/components/HiddenModelsManager";
import type { ConfiguredModelInfo } from "@/lib/types";

/** Group the models that aren't hidden by provider, preserving input order. */
export function groupVisibleModels(
  availableModels: ConfiguredModelInfo[],
  hiddenModels: ReadonlySet<string>,
): { visibleModels: ConfiguredModelInfo[]; modelGroups: Map<string, ConfiguredModelInfo[]> } {
  const visibleModels = availableModels.filter(
    (m) => !hiddenModels.has(modelKey(m.provider, m.id))
  );
  const modelGroups = new Map<string, ConfiguredModelInfo[]>();
  for (const model of visibleModels) {
    if (!modelGroups.has(model.provider)) modelGroups.set(model.provider, []);
    modelGroups.get(model.provider)!.push(model);
  }
  return { visibleModels, modelGroups };
}
