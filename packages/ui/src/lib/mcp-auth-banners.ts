type MessageLike = { key?: string | null };

export function replaceMessageByStableKey<T extends MessageLike>(
  messages: T[],
  stableKey: string,
  message: T,
): T[] {
  const idx = messages.findIndex((m) => m.key === stableKey);
  if (idx < 0) return [...messages, message];
  return messages.map((m) => (m.key === stableKey ? message : m));
}

export function removeMessagesByStableKey<T extends MessageLike>(
  messages: T[],
  stableKey: string,
): T[] {
  return messages.filter(
    (m) => m.key !== stableKey && !(typeof m.key === "string" && m.key.startsWith(`${stableKey}:`)),
  );
}
