export interface SigilResolveFailure {
  message: string;
  status?: number;
  retryable: boolean;
}

export async function formatSigilResolveError(response: Response): Promise<string> {
  let detail = "";
  try {
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const data = await response.clone().json() as { error?: unknown };
      if (typeof data?.error === "string" && data.error.trim()) {
        detail = data.error.trim();
      }
    }
    if (!detail) {
      const text = (await response.clone().text()).trim();
      if (text) detail = text;
    }
  } catch {
    // ignore body parsing failures
  }

  const base = `${response.status} ${response.statusText}`.trim();
  return detail ? `${base} — ${detail}` : base;
}

export function shouldRetrySigilResolveFailure(status?: number): boolean {
  return status === undefined || status >= 500 || status === 429;
}

export async function buildSigilResolveFailure(error: unknown, response?: Response): Promise<SigilResolveFailure> {
  if (response) {
    return {
      message: await formatSigilResolveError(response),
      status: response.status,
      retryable: shouldRetrySigilResolveFailure(response.status),
    };
  }

  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: true,
  };
}
