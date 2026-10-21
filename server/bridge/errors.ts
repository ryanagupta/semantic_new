import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

/** Preserve gateway policy details over transports that cannot carry HTTP status headers. */
export function gatewayMcpError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  const failure = error as { status?: unknown; retryAfter?: unknown; rate?: { limit: number; remaining: number; reset: number } } | null;
  const status = typeof failure?.status === 'number' ? failure.status : 500;
  const retryAfter = typeof failure?.retryAfter === 'number' ? failure.retryAfter : failure?.rate ? Math.max(1, failure.rate.reset - Math.floor(Date.now() / 1000)) : undefined;
  return new McpError(status === 400 ? ErrorCode.InvalidParams : -32000, error instanceof Error ? error.message : 'Gateway request failed.', {
    httpStatus: status,
    ...(failure?.rate ? { rateLimit: failure.rate } : {}),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  });
}
