import { sanitizeGoogleTurnOrdering } from "./bootstrap.js";

export function isGoogleModelApi(api?: string | null): boolean {
  return (
    api === "google-gemini-cli" || api === "google-generative-ai" || api === "google-antigravity"
  );
}

export function isAntigravityClaude(params: {
  api?: string | null;
  provider?: string | null;
  modelId?: string;
}): boolean {
  const provider = params.provider?.toLowerCase();
  const api = params.api?.toLowerCase();
  if (provider !== "google-antigravity" && api !== "google-antigravity") {
    return false;
  }
  return params.modelId?.toLowerCase().includes("claude") ?? false;
}

export { sanitizeGoogleTurnOrdering };

export function sanitizeToolUseInput(messages: unknown[]): unknown[] {
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const message = msg as { role?: string; content?: unknown } & Record<string, unknown>;
    if (message.role !== "assistant" && message.role !== "toolUse") {
      return msg;
    }
    if (!Array.isArray(message.content)) {
      return msg;
    }

    return {
      ...message,
      content: message.content.map((block: unknown) => {
        if (!block || typeof block !== "object") {
          return block;
        }
        const blockData = block as { type?: string; input?: unknown } & Record<string, unknown>;
        if (blockData.type === "toolUse" || blockData.type === "toolCall") {
          if (!("input" in blockData) || blockData.input === undefined) {
            return { ...blockData, input: {} };
          }
        }
        return block;
      }),
    };
  });
}
