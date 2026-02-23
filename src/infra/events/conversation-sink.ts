export interface ConversationSinkConfig {
  id: string;
  enabled: boolean;
  options: Record<string, unknown>;
}

export interface ConversationSink {
  readonly id: string;
  start(config: ConversationSinkConfig): () => void;
}
