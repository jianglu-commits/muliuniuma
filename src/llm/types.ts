export type ProviderId =
  | 'openai'
  | 'openai-compatible'
  | 'anthropic'
  | 'google'
  | 'ollama'
  | (string & {});

export interface ModelSpec {
  provider: ProviderId;
  model: string;
  baseURL?: string;
  apiKey?: string;
  temperature?: number;
}
