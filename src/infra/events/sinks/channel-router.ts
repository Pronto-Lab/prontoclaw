import type { APIChannel } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { listGuildChannelsDiscord, listThreadsDiscord } from "../../../discord/send.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";

const log = createSubsystemLogger("channel-router");

const ROUTER_TIMEOUT_MS = 15_000;
const THREAD_NAME_MAX = 100;

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
  archived: boolean;
}

interface ChannelInfo {
  id: string;
  name: string;
  topic?: string;
  parentName?: string;
  type: number;
}

export class ChannelRouter {
  private guildId: string;
  private defaultChannelId: string;
  private accountId: string;

  constructor(opts: { guildId: string; defaultChannelId: string; accountId: string }) {
    this.guildId = opts.guildId;
    this.defaultChannelId = opts.defaultChannelId;
    this.accountId = opts.accountId;
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
    const opts = { accountId: this.accountId };

    const [channels, threadsResponse] = await Promise.all([
      listGuildChannelsDiscord(this.guildId, opts),
      listThreadsDiscord({ guildId: this.guildId }, opts),
    ]);

    const textChannels = this.filterTextChannels(channels);
    const activeThreads = this.extractActiveThreads(threadsResponse);

    const matchingThread = this.findMatchingThread(activeThreads, context);
    if (matchingThread) {
      return {
        channelId: matchingThread.parentId,
        threadId: matchingThread.id,
        threadName: matchingThread.name,
        reasoning: `reusing existing thread "${matchingThread.name}"`,
      };
    }

    const channelId = this.pickChannel(textChannels, context);
    const threadName = this.generateThreadName(context);

    return {
      channelId,
      threadName,
      reasoning: `new thread in channel ${channelId}`,
    };
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
        type: ch.type,
      }));
  }

  private extractActiveThreads(response: unknown): ActiveThread[] {
    if (!response || typeof response !== "object") {
      return [];
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
        archived:
          typeof t.thread_metadata === "object" &&
          t.thread_metadata !== null &&
          (t.thread_metadata as Record<string, unknown>).archived === true,
      }))
      .filter((t) => t.id && !t.archived);
  }

  private findMatchingThread(
    threads: ActiveThread[],
    context: RouteContext,
  ): ActiveThread | undefined {
    if (threads.length === 0) {
      return undefined;
    }

    const keywords = this.extractKeywords(context.message);
    if (keywords.length === 0) {
      return undefined;
    }

    let bestMatch: ActiveThread | undefined;
    let bestScore = 0;

    for (const thread of threads) {
      const threadNameLower = thread.name.toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (threadNameLower.includes(kw)) {
          score++;
        }
      }
      const ratio = score / keywords.length;
      if (ratio >= 0.4 && score > bestScore) {
        bestScore = score;
        bestMatch = thread;
      }
    }

    return bestMatch;
  }

  private extractKeywords(message: string): string[] {
    const text = message.slice(0, 500).toLowerCase();
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "can",
      "shall",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "and",
      "or",
      "but",
      "not",
      "no",
      "if",
      "then",
      "so",
      "that",
      "this",
      "it",
      "its",
      "my",
      "your",
      "our",
      "their",
      "이",
      "그",
      "저",
      "을",
      "를",
      "은",
      "는",
      "이",
      "가",
      "에",
      "에서",
      "로",
      "으로",
      "와",
      "과",
      "의",
      "도",
      "좀",
      "수",
      "것",
      "거",
      "해",
      "할",
      "하고",
      "하는",
      "해줘",
    ]);
    return text
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 1 && !stopWords.has(w))
      .slice(0, 10);
  }

  private pickChannel(channels: ChannelInfo[], context: RouteContext): string {
    if (channels.length === 0) {
      return this.defaultChannelId;
    }

    const keywords = this.extractKeywords(context.message);
    if (keywords.length === 0) {
      return this.defaultChannelId;
    }

    let bestChannel: ChannelInfo | undefined;
    let bestScore = 0;

    for (const ch of channels) {
      const searchText = [ch.name, ch.topic ?? "", ch.parentName ?? ""].join(" ").toLowerCase();
      let score = 0;
      for (const kw of keywords) {
        if (searchText.includes(kw)) {
          score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestChannel = ch;
      }
    }

    return bestChannel?.id ?? this.defaultChannelId;
  }

  private generateThreadName(context: RouteContext): string {
    const firstLine =
      context.message
        .split("\n")
        .find((l) => l.trim())
        ?.trim() ?? "";

    if (firstLine.length > 0 && firstLine.length <= THREAD_NAME_MAX) {
      return firstLine.slice(0, THREAD_NAME_MAX);
    }

    if (firstLine.length > THREAD_NAME_MAX) {
      return firstLine.slice(0, THREAD_NAME_MAX - 3) + "...";
    }

    const ts = new Date().toISOString().slice(0, 16);
    return `${context.fromAgentName} ↔ ${context.toAgentName} · ${ts}`.slice(0, THREAD_NAME_MAX);
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
    const ts = new Date().toISOString().slice(0, 16);
    return {
      channelId: this.defaultChannelId,
      threadName: `${context.fromAgentName} ↔ ${context.toAgentName} · ${ts}`.slice(
        0,
        THREAD_NAME_MAX,
      ),
      reasoning: "fallback (timeout or error)",
    };
  }
}
