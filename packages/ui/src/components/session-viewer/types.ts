export interface RelayMessage {
  key: string;
  role: string;
  timestamp?: number;
  content?: unknown;
  toolName?: string;
  toolCallId?: string;
  toolInput?: unknown;
  isError?: boolean;
}
