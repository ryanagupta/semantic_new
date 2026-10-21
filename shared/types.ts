export type JsonSchema = Record<string, unknown>;
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
export interface ParameterMapping {
  name: string; in: 'path' | 'query' | 'header'; required?: boolean;
  inputProperty?: string; style?: 'simple' | 'form' | 'spaceDelimited' | 'pipeDelimited' | 'deepObject'; explode?: boolean;
}
export interface EndpointInput {
  name: string; description: string; method: HttpMethod; url: string;
  enabled: boolean; inputSchema: JsonSchema; parameters: ParameterMapping[];
  bodyProperty?: string; headers?: Record<string, string>; kind?: 'rest' | 'graphql';
}
export interface Endpoint extends EndpointInput { id: string; createdAt: string; updatedAt: string; }
export interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; rateLimit: number; createdAt: string; lastUsedAt: string | null; revokedAt: string | null; }
export interface Principal { id: string; scopes: string[]; rateLimit: number; rateKey?: string; }
export interface RequestLog { id: string; timestamp: string; endpointId: string | null; tool: string; method: string; status: number; latency: number; tokens: number; keyId: string | null; error: string | null; }
export interface Metrics { totalRequests: number; averageLatency: number; p95Latency: number; errorRate: number; activeKeys: number; totalTokens: number; endpoints: number; series: {time: string; requests: number; latency: number; errors: number; tokens: number}[]; recent: RequestLog[]; }
export interface UpstreamResult { status: number; contentType: string; body: string; bytes?: Buffer; }
