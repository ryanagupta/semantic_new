export type McpProvider = {
  id: string;
  displayName: string;
  category: 'Design' | 'Thinking' | 'Media Gen';
  access: 'free' | 'gated';
  description: string;
  configured: boolean;
  connected: boolean;
  authConfigured: boolean;
};

export type McpRegistry = { providers: McpProvider[] };
