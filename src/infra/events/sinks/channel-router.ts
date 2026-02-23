import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { APIChannel } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { getApiKeyForModel, requireApiKey } from "../../../agents/model-auth.js";
import { resolveModel } from "../../../agents/pi-embedded-runner/model.js";
import { loadConfig } from "../../../config/config.js";
import { listGuildChannelsDiscord, listThreadsDiscord } from "../../../discord/send.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("channel-router");

const ROUTER_TIMEOUT_MS = 15_000;
const THREAD_NAME_MAX = 100;
const MAX_PROMPT_MESSAGE_LENGTH = 500;

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

interface ActiveThread {
  id: string;
  name: string;
  parentId: string;
  parentName?: string;
  messageCount?: number;
  lastMessageAt?: string;
}

interface ChannelInfo {
  id: string;
  name: string;
  topic?: string;
  parentName?: string;
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

function isTextContentBlock(block: unknown): block is TextContent {
  return (
    block !== null &&
    typeof block === "object" &&
    (block as Record<string, unknown>).type === "text" &&
    typeof (block as Record<string, unknown>).text === "string"
  );
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
    const discordOpts = { accountId: this.accountId };

    const [channels, threadsResponse] = await Promise.all([
      listGuildChannelsDiscord(this.guildId, discordOpts),
      listThreadsDiscord({ guildId: this.guildId }, discordOpts),
    ]);

    const textChannels = this.filterTextChannels(channels);
    const activeThreads = this.extractActiveThreads(channels, threadsResponse);

    const llmResult = await this.callRouterLLM(context, textChannels, activeThreads);
    if (llmResult) {
      return llmResult;
    }

    return this.buildFallback(context);
  }

  private async callRouterLLM(
    context: RouteContext,
    channels: ChannelInfo[],
    threads: ActiveThread[],
  ): Promise<RouteResult | null> {
    const cfg = loadConfig();
    const { provider, model: modelId } = parseModelString(this.routerModel);
    const resolved = resolveModel(provider, modelId, undefined, cfg);

    if (!resolved.model) {
      log.warn("router model not found, falling back", {
        model: this.routerModel,
        error: resolved.error,
      });
      return null;
    }

    let apiKey: string;
    try {
      apiKey = requireApiKey(await getApiKeyForModel({ model: resolved.model, cfg }), provider);
    } catch (err) {
      log.warn("router model API key not available", { error: String(err) });
      return null;
    }

    const prompt = this.buildPrompt(context, channels, threads);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS - 2000);

    try {
      const res = await completeSimple(
        resolved.model,
        {
          messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
        },
        {
          apiKey,
          maxTokens: 300,
          temperature: 0,
          signal: controller.signal,
        },
      );

      const text = res.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join(" ")
        .trim();

      return this.parseResponse(text, channels, threads, context);
    } catch (err) {
      log.warn("router LLM call failed", { error: String(err) });
      return null;
    } finally {
      clearTimeout(timeout);
    }
  }

  private buildPrompt(
    context: RouteContext,
    channels: ChannelInfo[],
    threads: ActiveThread[],
  ): string {
    const channelList = channels
      .map((ch) => {
        const parts = [`- id:${ch.id} name:#${ch.name}`];
        if (ch.topic) {
          parts.push(`topic:"${ch.topic}"`);
        }
        if (ch.parentName) {
          parts.push(`category:${ch.parentName}`);
        }
        return parts.join(" ");
      })
      .join("\n");

    const threadList =
      threads.length > 0
        ? threads
            .map((t) => {
              const parts = [`- id:${t.id} name:"${t.name}" channel:${t.parentId}`];
              if (t.parentName) {
                parts.push(`(#${t.parentName})`);
              }
              if (t.messageCount) {
                parts.push(`msgs:${t.messageCount}`);
              }
              return parts.join(" ");
            })
            .join("\n")
        : "(no active threads)";

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

[Available Channels]
${channelList}

[Active Threads]
${threadList}

[Instructions]
1. Check if any existing thread's topic closely matches this conversation
   - If YES: return that thread (reuse)
   - If NO: pick the most appropriate channel and create a new thread name
2. Thread name rules:
   - Korean, concise, max 50 chars
   - Describe the discussion topic (not the agents)
   - Examples: "Gateway 메모리 누수 분석", "task-hub DM 시스템 마이그레이션"
3. Default channel (fallback): ${this.defaultChannelId}

Return ONLY a JSON object (no markdown, no explanation):
{"channelId": "...", "threadId": "...or null", "threadName": "...", "reasoning": "..."}`;
  }

  private parseResponse(
    text: string,
    channels: ChannelInfo[],
    threads: ActiveThread[],
    context: RouteContext,
  ): RouteResult | null {
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.warn("no JSON found in router response", { text: text.slice(0, 200) });
        return null;
      }

      const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
      const channelId = typeof parsed.channelId === "string" ? parsed.channelId : "";
      const threadId =
        typeof parsed.threadId === "string" && parsed.threadId !== "null"
          ? parsed.threadId
          : undefined;
      const threadName = typeof parsed.threadName === "string" ? parsed.threadName : "";
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;

      if (!channelId && !threadId) {
        log.warn("router response missing channelId and threadId");
        return null;
      }

      if (threadId) {
        const thread = threads.find((t) => t.id === threadId);
        if (!thread) {
          log.warn("router returned unknown threadId", { threadId });
          return null;
        }
        return {
          channelId: thread.parentId,
          threadId: thread.id,
          threadName: thread.name,
          reasoning: reasoning ?? `reusing existing thread "${thread.name}"`,
        };
      }

      const channel = channels.find((ch) => ch.id === channelId);
      const resolvedChannelId = channel ? channel.id : this.defaultChannelId;
      const resolvedThreadName =
        threadName.slice(0, THREAD_NAME_MAX) || this.generateFallbackName(context);

      return {
        channelId: resolvedChannelId,
        threadName: resolvedThreadName,
        reasoning,
      };
    } catch (err) {
      log.warn("failed to parse router response", { error: String(err), text: text.slice(0, 200) });
      return null;
    }
  }

  private filterTextChannels(channels: APIChannel[]): ChannelInfo[] {
    const categories = new Map<string, string>();
    for (const ch of channels) {
      if (ch.type === ChannelType.GuildCategory && "name" in ch && ch.name) {
        categories.set(ch.id, ch.name);
      }
    }

    return channels
      .filter((ch) => ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildForum)
      .map((ch) => ({
        id: ch.id,
        name: "name" in ch ? (ch.name ?? "") : "",
        topic: "topic" in ch ? (ch.topic ?? undefined) : undefined,
        parentName: "parent_id" in ch && ch.parent_id ? categories.get(ch.parent_id) : undefined,
      }));
  }

  private extractActiveThreads(channels: APIChannel[], response: unknown): ActiveThread[] {
    if (!response || typeof response !== "object") {
      return [];
    }

    const categories = new Map<string, string>();
    for (const ch of channels) {
      if (
        (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildForum) &&
        "name" in ch &&
        ch.name
      ) {
        categories.set(ch.id, ch.name);
      }
    }

    const data = response as { threads?: unknown[] };
    if (!Array.isArray(data.threads)) {
      return [];
    }
    return data.threads
      .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
      .map((t) => ({
        id: typeof t.id === "string" ? t.id : "",
        name: typeof t.name === "string" ? t.name : "",
        parentId: typeof t.parent_id === "string" ? t.parent_id : "",
        parentName: typeof t.parent_id === "string" ? categories.get(t.parent_id) : undefined,
        messageCount: typeof t.message_count === "number" ? t.message_count : undefined,
        lastMessageAt: typeof t.last_message_id === "string" ? t.last_message_id : undefined,
        archived:
          typeof t.thread_metadata === "object" &&
          t.thread_metadata !== null &&
          (t.thread_metadata as Record<string, unknown>).archived === true,
      }))
      .filter((t) => t.id && !(t as Record<string, unknown>).archived)
      .map(({ archived: _archived, ...rest }) => rest as ActiveThread);
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
