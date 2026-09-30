import { EyeOff } from "lucide-react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorShortcut,
} from "@/components/ai-elements/model-selector";
import type { ConfiguredModelInfo } from "@/lib/types";
import { groupVisibleModels } from "../model-groups";

/** Command-palette model picker (shared by mobile and desktop). */
export function ModelSelectorDialog({
  open,
  onOpenChange,
  activeModel,
  availableModels,
  hiddenModels,
  onSelectModel,
  onManageVisibility,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeModel: ConfiguredModelInfo | null;
  availableModels: ConfiguredModelInfo[];
  hiddenModels: Set<string>;
  onSelectModel: (model: ConfiguredModelInfo) => void;
  onManageVisibility: () => void;
}) {
  const activeModelKey = activeModel ? `${activeModel.provider}/${activeModel.id}` : "";
  const { visibleModels, modelGroups } = groupVisibleModels(availableModels, hiddenModels);

  return (
    <ModelSelector open={open} onOpenChange={onOpenChange}>
      <div className="hidden" />
      <ModelSelectorContent
        className="sm:max-w-xl"
        defaultValue={activeModel ? `${activeModel.provider} ${activeModel.id} ${activeModel.name ?? ""}`.toLowerCase() : undefined}
      >
        <ModelSelectorInput placeholder="Search configured models…" />
        <ModelSelectorList className="max-h-[min(60dvh,400px)]">
          <ModelSelectorEmpty>
            {availableModels.length > 0 && visibleModels.length === 0
              ? "All models are hidden. Manage visibility in settings."
              : "No models configured. Add provider credentials on the runner (API keys or provider login) to see models here."}
          </ModelSelectorEmpty>
          {Array.from(modelGroups.entries()).map(([provider, models]) => (
            <ModelSelectorGroup key={provider} heading={provider}>
              {models.map((model) => {
                const mk = `${model.provider}/${model.id}`;
                const isActive = mk === activeModelKey;
                return (
                  <ModelSelectorItem
                    key={mk}
                    value={`${model.provider} ${model.id} ${model.name ?? ""}`.toLowerCase()}
                    onSelect={() => onSelectModel(model)}
                  >
                    <ModelSelectorLogo provider={model.provider} />
                    <ModelSelectorName>
                      <span className="font-medium">{model.name || model.id}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{model.id}</span>
                    </ModelSelectorName>
                    {isActive && <ModelSelectorShortcut>Current</ModelSelectorShortcut>}
                  </ModelSelectorItem>
                );
              })}
            </ModelSelectorGroup>
          ))}
          {/* Manage model visibility link */}
          {availableModels.length > 0 && (
            <div className="border-t px-2 py-2">
              <button
                type="button"
                onClick={onManageVisibility}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
              >
                <EyeOff className="h-3.5 w-3.5" />
                {hiddenModels.size > 0
                  ? `Manage model visibility (${hiddenModels.size} hidden)`
                  : "Manage model visibility"}
              </button>
            </div>
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}
