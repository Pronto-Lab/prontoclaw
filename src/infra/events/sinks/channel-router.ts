import { complete } from "@mariozechner/pi-ai";
import type { Context, TextContent, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { ChannelType } from "discord-api-types/v10";
import { getApiKeyForModel, requireApiKey } from "../../../agents/model-auth.js";
import { resolveModel } from "../../../agents/pi-embedded-runner/model.js";
import { loadConfig } from "../../../config/config.js";
import {
  listGuildChannelsDiscord,
  listThreadsDiscord,
  readMessagesDiscord,
} from "../../../discord/send.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("channel-router");

const ROUTER_TIMEOUT_MS = 15_000;
const THREAD_NAME_MAX = 100;
const MAX_PROMPT_MESSAGE_LENGTH = 500;
const MAX_TOOL_TURNS = 3;

export interface RouteContext {
  message: string;
  fromAgent: string;
  toAgent: string;
  fromAgentName: string;
  toAgentName: string;
  topicId?: string;
  conversationId: string;
}

export interface RouteResult {
  channelId: string;
  threadId?: string;
  threadName: string;
  reasoning?: string;
}

interface RouterModelConfig {
  provider: string;
  model: string;
}

function parseModelString(modelString: string): RouterModelConfig {
  const parts = modelString.split("/");
  if (parts.length >= 2) {
    return { provider: parts[0], model: parts.slice(1).join("/") };
  }
  return { provider: "anthropic", model: modelString };
}

function isTextContent(block: unknown): block is TextContent {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as Record<string, unknown>).type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
}

function isToolCall(block: unknown): block is ToolCall {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as Record<string, unknown>).type === "toolCall" &&
    typeof (block as Record<string, unknown>).id === "string" &&
    typeof (block as Record<string, unknown>).name === "string"
  );
}

function buildToolDefinitions(): Tool[] {
  return [
    {
      name: "listGuildChannels",
      description:
        "List all text channels in the Discord guild. Returns array of {id, name, topic, category}.",
      parameters: Type.Object({
        guildId: Type.String({ description: "The Discord guild ID" }),
      }),
    },
    {
      name: "listActiveThreads",
      description:
        "List all active (non-archived) threads in the Discord guild. Returns array of {id, name, parentId, messageCount}.",
      parameters: Type.Object({
        guildId: Type.String({ description: "The Discord guild ID" }),
      }),
    },
    {
      name: "readRecentMessages",
      description:
        "Read recent messages from a thread to check if its topic matches the new conversation. Returns array of {author, content, timestamp}.",
      parameters: Type.Object({
        threadId: Type.String({ description: "The thread or channel ID to read messages from" }),
        limit: Type.Optional(
          Type.Number({ description: "Number of messages to fetch (1-10, default 3)" }),
        ),
      }),
    },
  ];
}

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  accountId: string,
): Promise<string> {
  const discordOpts = { accountId };

  switch (toolName) {
    case "listGuildChannels": {
      const guildId = typeof args.guildId === "string" ? args.guildId : "";
      const channels = await listGuildChannelsDiscord(guildId, discordOpts);
      const categories = new Map<string, string>();
      for (const ch of channels) {
        if (ch.type === ChannelType.GuildCategory && "name" in ch && ch.name) {
          categories.set(ch.id, ch.name);
        }
      }
      const textChannels = channels
        .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildForum)
        .map((ch) => ({
          id: ch.id,
          name: "name" in ch ? (ch.name ?? "") : "",
          topic: "topic" in ch ? (ch.topic ?? null) : null,
          category:
            "parent_id" in ch && ch.parent_id ? (categories.get(ch.parent_id) ?? null) : null,
        }));
      return JSON.stringify(textChannels);
    }

    case "listActiveThreads": {
      const guildId = typeof args.guildId === "string" ? args.guildId : "";
      const response = await listThreadsDiscord({ guildId }, discordOpts);
      if (!response || typeof response !== "object") {
        return JSON.stringify([]);
      }
      const data = response as { threads?: unknown[] };
      if (!Array.isArray(data.threads)) {
        return JSON.stringify([]);
      }
      const threads = data.threads
        .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
        .filter((t) => {
          if (typeof t.thread_metadata === "object" && t.thread_metadata !== null) {
            return (t.thread_metadata as Record<string, unknown>).archived !== true;
          }
          return true;
        })
        .map((t) => ({
          id: typeof t.id === "string" ? t.id : "",
          name: typeof t.name === "string" ? t.name : "",
          parentId: typeof t.parent_id === "string" ? t.parent_id : "",
          messageCount: typeof t.message_count === "number" ? t.message_count : null,
        }))
        .filter((t) => t.id);
      return JSON.stringify(threads);
    }

    case "readRecentMessages": {
      const threadId = typeof args.threadId === "string" ? args.threadId : "";
      const limit = Math.min(Math.max(Number(args.limit) || 3, 1), 10);
      const messages = await readMessagesDiscord(threadId, { limit }, discordOpts);
      const simplified = messages.map((m) => ({
        author: m.author?.username ?? "unknown",
        content: (m.content ?? "").slice(0, 200),
        timestamp: m.timestamp,
      }));
      return JSON.stringify(simplified);
    }

    default:
      return JSON.stringify({ error: `Unknown tool: ${toolName}` });
  }
}

function buildSubagentSystemPrompt(
  context: RouteContext,
  guildId: string,
  defaultChannelId: string,
): string {
  const truncatedMessage = context.message.slice(0, MAX_PROMPT_MESSAGE_LENGTH);
  return `You are a Discord thread router for an AI agent team.
Your job: find the best place for an agent-to-agent conversation.

[New Conversation]
From: ${context.fromAgent} (${context.fromAgentName})
To: ${context.toAgent} (${context.toAgentName})
Topic ID: ${context.topicId ?? "N/A"}
First message:
---
${truncatedMessage}
---

[Instructions]
1. Use listGuildChannels to see all available channels (guildId: ${guildId})
2. Use listActiveThreads to see existing threads (guildId: ${guildId})
3. Check if any existing thread's topic closely matches this conversation
   - If YES: return that thread (reuse)
   - If NO: pick the most appropriate channel and create a new thread name
4. Optionally use readRecentMessages to verify a thread's topic before reusing it
5. Thread name rules:
   - Korean, concise, max 50 chars
   - Describe the discussion topic (not the agents)
   - Examples: "Gateway 메모리 누수 분석", "task-hub DM 시스템 마이그레이션"
6. Default channel (fallback): ${defaultChannelId}
CRITICAL: Your final response MUST be ONLY raw JSON (no markdown, no code fences, no explanation).
Example: {"channelId": "123", "threadId": null, "threadName": "topic name", "reasoning": "brief reason"}`;
}

export class ChannelRouter {
  private guildId: string;
  private defaultChannelId: string;
  private accountId: string;
  private routerModel: string;

  constructor(opts: {
    guildId: string;
    defaultChannelId: string;
    accountId: string;
    routerModel?: string;
  }) {
    this.guildId = opts.guildId;
    this.defaultChannelId = opts.defaultChannelId;
    this.accountId = opts.accountId;
    this.routerModel = opts.routerModel ?? "anthropic/claude-sonnet-4-5";
  }

  async route(context: RouteContext): Promise<RouteResult> {
    try {
      return await Promise.race([this.doRoute(context), this.timeoutFallback(context)]);
    } catch (err) {
      log.warn("routing failed, using fallback", { error: String(err) });
      return this.buildFallback(context);
    }
  }

  private async doRoute(context: RouteContext): Promise<RouteResult> {
    const cfg = loadConfig();
    const { provider, model: modelId } = parseModelString(this.routerModel);
    const resolved = resolveModel(provider, modelId, undefined, cfg);

    if (!resolved.model) {
      log.warn("router model not found, falling back", {
        model: this.routerModel,
        error: resolved.error,
      });
      return this.buildFallback(context);
    }

    let apiKey: string;
    try {
      apiKey = requireApiKey(await getApiKeyForModel({ model: resolved.model, cfg }), provider);
    } catch (err) {
      log.warn("router model API key not available", { error: String(err) });
      return this.buildFallback(context);
    }

    const tools = buildToolDefinitions();
    const systemPrompt = buildSubagentSystemPrompt(context, this.guildId, this.defaultChannelId);
    const llmContext: Context = {
      systemPrompt,
      messages: [
        {
          role: "user",
          content:
            "Route this conversation. Use the tools to inspect the Discord guild, then return your JSON routing decision.",
          timestamp: Date.now(),
        },
      ],
      tools,
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS - 2000);

    try {
      const result = await this.runToolLoop(resolved.model, llmContext, apiKey, controller.signal);
      if (result) {
        return result;
      }
      return this.buildFallback(context);
    } catch (err) {
      log.warn("sub-agent routing failed", { error: String(err) });
      return this.buildFallback(context);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runToolLoop(
    model: Parameters<typeof complete>[0],
    llmContext: Context,
    apiKey: string,
    signal: AbortSignal,
  ): Promise<RouteResult | null> {
    for (let turn = 0; turn <= MAX_TOOL_TURNS; turn++) {
      const response = await complete(model, llmContext, {
        apiKey,
        maxTokens: 1024,
        temperature: 0,
        signal,
      });

      if (response.stopReason !== "toolUse" || turn === MAX_TOOL_TURNS) {
        if (turn === MAX_TOOL_TURNS && response.stopReason === "toolUse") {
          log.warn("sub-agent exceeded max tool turns, extracting result");
        }
        const text = response.content
          .filter(isTextContent)
          .map((b) => b.text.trim())
          .filter(Boolean)
          .join(" ")
          .trim();
        log.info("sub-agent final response", {
          turns: turn,
          stopReason: response.stopReason,
          textLen: text.length,
          text: text.slice(0, 300),
          contentTypes: response.content.map((b) => (b as Record<string, unknown>).type).join(","),
        });
        return this.parseResponse(text);
      }

      llmContext.messages.push(response);
      const toolCalls = response.content.filter(isToolCall);
      for (const call of toolCalls) {
        log.info("sub-agent tool call", { tool: call.name, turn });
        let resultText: string;
        try {
          resultText = await executeTool(call.name, call.arguments, this.accountId);
        } catch (err) {
          resultText = JSON.stringify({ error: String(err) });
          log.warn("tool execution failed", { tool: call.name, error: String(err) });
        }
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: resultText }],
          isError: false,
          timestamp: Date.now(),
        };
        llmContext.messages.push(toolResult);
      }
    }
    return null;
  }

  private parseResponse(text: string): RouteResult | null {
    try {
      let jsonStr: string | undefined;
      const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fencedMatch) {
        jsonStr = fencedMatch[1].trim();
      } else {
        const rawMatch = text.match(/\{[\s\S]*\}/);
        jsonStr = rawMatch?.[0];
      }
      if (!jsonStr) {
        log.warn("no JSON found in sub-agent response", { text: text.slice(0, 300) });
        return null;
      }

      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const channelId = typeof parsed.channelId === "string" ? parsed.channelId : "";
      const threadId =
        typeof parsed.threadId === "string" && parsed.threadId !== "null"
          ? parsed.threadId
          : undefined;
      const threadName = typeof parsed.threadName === "string" ? parsed.threadName : "";
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;

      if (threadId) {
        return {
          channelId: channelId || this.defaultChannelId,
          threadId,
          threadName: threadName || "reused thread",
          reasoning: reasoning ?? "reusing existing thread",
        };
      }

      if (!channelId) {
        log.warn("sub-agent response missing channelId");
        return null;
      }

      return {
        channelId,
        threadName:
          threadName.slice(0, THREAD_NAME_MAX) || this.generateFallbackName({} as RouteContext),
        reasoning,
      };
    } catch (err) {
      log.warn("failed to parse sub-agent response", {
        error: String(err),
        text: text.slice(0, 200),
      });
      return null;
    }
  }

  private generateFallbackName(context: RouteContext): string {
    const ts = new Date().toISOString().slice(0, 16);
    if (context?.fromAgentName && context?.toAgentName) {
      return `${context.fromAgentName} ↔ ${context.toAgentName} · ${ts}`.slice(0, THREAD_NAME_MAX);
    }
    return `conversation · ${ts}`.slice(0, THREAD_NAME_MAX);
  }

  private async timeoutFallback(context: RouteContext): Promise<RouteResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        log.warn("routing timed out, using fallback");
        resolve(this.buildFallback(context));
      }, ROUTER_TIMEOUT_MS);
    });
  }

  private buildFallback(context: RouteContext): RouteResult {
    return {
      channelId: this.defaultChannelId,
      threadName: this.generateFallbackName(context),
      reasoning: "fallback (timeout or error)",
    };
  }
}
