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

const ROUTER_TIMEOUT_MS = 30_000;
const RETRY_DELAY_MS = 2_000;
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
  channelHint?: string;
  threadIdHint?: string;
  threadNameHint?: string;
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

const TOPIC_NOISE_PATTERN =
  /^(\S+[!?]\s*|\S+에게\s+|\S+한테\s+|\S+에게로?\s+|다음\s+메시지를?\s+전달해\s*[줘주]?:?\s*|전달해\s*[줘주]?:?\s*)/;
const TOPIC_SUFFIX_NOISE = /[\s,.!?~…]+$/;
const TOPIC_MAX_LENGTH = 40;

interface CategoryRule {
  category: string;
  keywords: string[];
}

const CATEGORY_RULES: CategoryRule[] = [
  {
    category: "검토",
    keywords: ["검토", "리뷰", "review", "확인", "피드백", "feedback", "수정", "개선", "코드 리뷰"],
  },
  {
    category: "요청",
    keywords: [
      "요청",
      "부탁",
      "해줘",
      "해주세요",
      "만들어",
      "작성",
      "추가",
      "생성",
      "구현",
      "개발",
    ],
  },
  {
    category: "협업",
    keywords: [
      "협업",
      "같이",
      "함께",
      "공동",
      "설계",
      "design",
      "아키텍처",
      "architecture",
      "기획",
    ],
  },
  {
    category: "논의",
    keywords: ["논의", "토론", "의견", "discuss", "어떻게", "방향", "전략", "strategy", "고민"],
  },
  {
    category: "보고",
    keywords: ["보고", "결과", "완료", "report", "분석", "analysis", "현황", "상태", "진행"],
  },
  {
    category: "공유",
    keywords: ["공유", "share", "참고", "안내", "알림", "전달", "공지"],
  },
];

function inferCategory(message: string): string {
  const lower = message.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((kw) => lower.includes(kw))) {
      return rule.category;
    }
  }
  return "협업";
}

function extractKeyNounPhrase(message: string): string | null {
  let text = message.replace(/\n/g, " ").trim();
  if (!text) {
    return null;
  }

  text = text.replace(TOPIC_NOISE_PATTERN, "").trim();
  text = text.replace(/^(안녕|안녕하세요|네|응|좋아|아주 좋아|잘)\s*/i, "").trim();
  text = text.replace(/^(좋[아은]|괜찮[아은]|알겠[어습]|감사)[^.!?\s]*/i, "").trim();
  text = text.replace(TOPIC_SUFFIX_NOISE, "").trim();

  if (!text || text.length < 3) {
    return null;
  }

  const firstClause = text.split(/[.!?。,\n]/)[0]?.trim() ?? text;
  if (firstClause.length > TOPIC_MAX_LENGTH) {
    return firstClause.slice(0, TOPIC_MAX_LENGTH);
  }
  return firstClause || null;
}

function generateAgendaName(context: RouteContext): string {
  const category = inferCategory(context.message);
  const noun = extractKeyNounPhrase(context.message);

  if (noun) {
    return `[${category}] ${noun}`.slice(0, THREAD_NAME_MAX);
  }

  return `[${category}] ${context.fromAgentName} · ${context.toAgentName} 협업`.slice(
    0,
    THREAD_NAME_MAX,
  );
}

function isRateLimitError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests");
}

function buildSubagentSystemPrompt(
  context: RouteContext,
  guildId: string,
  defaultChannelId: string,
): string {
  const truncatedMessage = context.message.slice(0, MAX_PROMPT_MESSAGE_LENGTH);
  return `You are a Discord channel router. Route agent conversations to the right thread.

CONVERSATION:
From: ${context.fromAgent} (${context.fromAgentName})
To: ${context.toAgent} (${context.toAgentName})
Message: ${truncatedMessage}
INSTRUCTIONS:
1. Call listGuildChannels AND listActiveThreads in PARALLEL (both need guildId: "${guildId}").
2. Check active thread NAMES for topic overlap. Thread names follow [카테고리] 주제 format.
   - If a thread covers the same subject → reuse it (set threadId to that thread's id).
   - Only use readRecentMessages if two threads look equally relevant.
3. If no thread matches → pick the best channel and set threadId to null.
4. Default channel if unsure: ${defaultChannelId}

THREAD NAME RULES (for new threads only):
- Format: [카테고리] 주제 (Korean, max 50 chars)
- 주제 = short topic noun phrase. NOT the message. Extract the core subject.
- Categories: 논의, 요청, 검토, 협업, 공유, 보고, 기타
- GOOD: [요청] 홈페이지 디자인 피드백, [논의] 배포 인프라 점검, [협업] 이벤트 시스템 설계
- BAD: [요청] 이든! 병욱이 홈페이지 디자인 피드백 좀 해달라고 했어 (this is a message, not a topic)

RESPOND WITH ONLY THIS JSON (no markdown, no explanation):
{"channelId":"...","threadId":"...or null","threadName":"[카테고리] 주제","reasoning":"..."}`;
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
    if (context.threadIdHint) {
      log.info("reusing thread from cache hint", {
        consoleMessage: `cache hit: reusing thread ${context.threadIdHint} in channel ${context.channelHint}`,
        threadId: context.threadIdHint,
        channelId: context.channelHint,
      });
      return {
        channelId: context.channelHint ?? this.defaultChannelId,
        threadId: context.threadIdHint,
        threadName: context.threadNameHint ?? "cached thread",
        reasoning: "reused from persistent cache",
      };
    }

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

    log.info("router model resolved", {
      consoleMessage: `router model resolved: ${this.routerModel} → ${resolved.model?.id ?? "null"} (error: ${resolved.error ?? "none"})`,
      requested: this.routerModel,
      resolvedId: resolved.model?.id,
      error: resolved.error,
    });
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

    for (let attempt = 0; attempt < 2; attempt++) {
      const llmContext: Context = {
        systemPrompt,
        messages: [
          {
            role: "user",
            content: "Route this conversation. Respond with ONLY the JSON object, nothing else.",
            timestamp: Date.now(),
          },
        ],
        tools,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), ROUTER_TIMEOUT_MS - 2000);

      try {
        const result = await this.runToolLoop(
          resolved.model,
          llmContext,
          apiKey,
          controller.signal,
        );
        if (result) {
          return result;
        }
      } catch (err) {
        clearTimeout(timeout);
        if (attempt === 0 && isRateLimitError(err)) {
          log.warn("rate limit hit, retrying after delay", {
            consoleMessage: `429 rate limit — retrying in ${RETRY_DELAY_MS}ms`,
            attempt,
          });
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          continue;
        }
        log.warn("sub-agent routing failed", { error: String(err), attempt });
        return this.buildFallback(context);
      } finally {
        clearTimeout(timeout);
      }
    }

    return this.buildFallback(context);
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

      if (response.stopReason === "error") {
        const responseStr = JSON.stringify(response);
        if (isRateLimitError(responseStr)) {
          throw new Error(`Rate limit: ${responseStr.slice(0, 200)}`);
        }
        log.warn("sub-agent LLM error", {
          consoleMessage: `sub-agent LLM error: ${responseStr.slice(0, 500)}`,
          model: this.routerModel,
          response: responseStr.slice(0, 1000),
        });
      }

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
          consoleMessage: `sub-agent final response (turns=${turn} stop=${response.stopReason} textLen=${text.length}): ${text.slice(0, 200)}`,
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
        log.info("sub-agent tool call", {
          consoleMessage: `sub-agent tool call: ${call.name} (turn ${turn})`,
          tool: call.name,
          turn,
        });
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
      let threadName = typeof parsed.threadName === "string" ? parsed.threadName : "";
      const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : undefined;
      if (threadName && !/^\[.+?\]\s/.test(threadName)) {
        threadName = `[기타] ${threadName}`;
      }

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
        threadName: threadName.slice(0, THREAD_NAME_MAX) || "새로운 협업 대화",
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
    return generateAgendaName(context);
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
      channelId: context.channelHint ?? this.defaultChannelId,
      threadName: this.generateFallbackName(context),
      reasoning: `fallback (channel: ${context.channelHint ? "from cache" : "default"})`,
    };
  }
}
