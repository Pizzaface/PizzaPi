export type DeferLoadingMode = "inherit" | "always" | "never";

export function deferLoadingValueToMode(value: boolean | undefined): DeferLoadingMode {
  if (value === true) return "always";
  if (value === false) return "never";
  return "inherit";
}

export function applyDeferLoadingMode<T extends object>(
  entry: T,
  mode: DeferLoadingMode,
): T & { deferLoading?: boolean } {
  if (mode === "inherit") {
    const { deferLoading: _omit, ...rest } = entry as T & { deferLoading?: boolean };
    return rest as T & { deferLoading?: boolean };
  }
  return {
    ...entry,
    deferLoading: mode === "always",
  };
}
