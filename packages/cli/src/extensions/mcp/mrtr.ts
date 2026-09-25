import { isRecord, type McpElicitationHandler } from "./types.js";

export const DEFAULT_MRTR_MAX_ROUNDS = 8;

type Request = (params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

/** Execute a modern MCP request, satisfying bounded MRTR input rounds. */
export async function requestWithMrtr(
  request: Request,
  initialParams: Record<string, unknown>,
  onElicitation?: McpElicitationHandler,
  signal?: AbortSignal,
  maxRounds = DEFAULT_MRTR_MAX_ROUNDS,
): Promise<unknown> {
  let params = { ...initialParams };

  for (let round = 0; ; round++) {
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted", "AbortError");
    const result = await request(params, signal);
    if (!isRecord(result) || result.resultType !== "input_required") return result;
    if (round >= maxRounds) throw new Error(`MCP MRTR exceeded ${maxRounds} input rounds`);

    if ("requestState" in result && typeof result.requestState !== "string") throw new Error("MCP MRTR requestState must be an opaque string");
    const requests = result.inputRequests;
    if (requests !== undefined && !isRecord(requests)) throw new Error("MCP MRTR inputRequests must be an object");
    if (requests === undefined && !("requestState" in result)) {
      throw new Error("MCP MRTR input_required result has neither inputRequests nor requestState");
    }

    const entries = requests ? Object.entries(requests) : [];
    // Validate the whole round before invoking any handler: partial retries are forbidden.
    for (const [key, value] of entries) {
      if (!isRecord(value) || value.method !== "elicitation/create" || !onElicitation) {
        const method = isRecord(value) && typeof value.method === "string" ? value.method : "invalid request";
        throw new Error(`Unsupported MCP MRTR input request "${key}": ${method}`);
      }
    }

    const inputResponses: Record<string, unknown> = Object.create(null);
    for (const [key, value] of entries) {
      signal?.throwIfAborted();
      inputResponses[key] = await onElicitation!((value as Record<string, unknown>).params, signal);
    }

    params = { ...initialParams, inputResponses };
    // Opaque state is copied by reference/value exactly, and omitted when absent.
    if ("requestState" in result) params.requestState = result.requestState;
  }
}
