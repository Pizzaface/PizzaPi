export function isCancelTriggerAction(action: unknown): boolean {
    return typeof action === "string" && action.trim().toLowerCase() === "cancel";
}
