export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); this.name = 'ApiError'; }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...init,
    credentials: 'include',
    cache: 'no-store',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    if (response.status === 401 && typeof window !== 'undefined') window.dispatchEvent(new Event('nexus:unauthorized'));
    const detail = body && typeof body === 'object' && 'error' in body ? body.error : null;
    const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object' && 'message' in detail ? String(detail.message) : `Request failed (${response.status})`;
    throw new ApiError(message, response.status);
  }
  return body as T;
}

export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'Something went wrong. Please try again.'; }
export const jsonBody = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
