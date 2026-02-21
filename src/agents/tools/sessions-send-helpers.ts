import {
  getChannelPlugin,
  normalizeChannelId as normalizeAnyChannelId,
} from "../../channels/plugins/index.js";
import { normalizeChannelId as normalizeChatChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import { callGateway } from "../../gateway/call.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveAgentConfig } from "../agent-scope.js";
import { buildPayloadSummary } from "./a2a-payload-parser.js";
import type { A2APayload } from "./a2a-payload-types.js";
import { extractAssistantText, stripToolMessages } from "./sessions-helpers.js";

const ANNOUNCE_SKIP_TOKEN = "ANNOUNCE_SKIP";
const REPLY_SKIP_TOKEN = "REPLY_SKIP";
const DEFAULT_PING_PONG_TURNS = 30;
const MAX_PING_PONG_TURNS = 30;

export type AnnounceTarget = {
  channel: string;
  to: string;
  accountId?: string;
  threadId?: string; // Forum topic/thread ID
};

export function resolveAnnounceTargetFromKey(sessionKey: string): AnnounceTarget | null {
  const rawParts = sessionKey.split(":").filter(Boolean);
  const parts = rawParts.length >= 3 && rawParts[0] === "agent" ? rawParts.slice(2) : rawParts;
  if (parts.length < 3) {
    return null;
  }
  const [channelRaw, kind, ...rest] = parts;
  if (kind !== "group" && kind !== "channel") {
    return null;
  }

  // Extract topic/thread ID from rest (supports both :topic: and :thread:)
  // Telegram uses :topic:, other platforms use :thread:
  let threadId: string | undefined;
  const restJoined = rest.join(":");
  const topicMatch = restJoined.match(/:topic:(\d+)$/);
  const threadMatch = restJoined.match(/:thread:(\d+)$/);
  const match = topicMatch || threadMatch;

  if (match) {
    threadId = match[1]; // Keep as string to match AgentCommandOpts.threadId
  }

  // Remove :topic:N or :thread:N suffix from ID for target
  const id = match ? restJoined.replace(/:(topic|thread):\d+$/, "") : restJoined.trim();

  if (!id) {
    return null;
  }
  if (!channelRaw) {
    return null;
  }
  const normalizedChannel = normalizeAnyChannelId(channelRaw) ?? normalizeChatChannelId(channelRaw);
  const channel = normalizedChannel ?? channelRaw.toLowerCase();
  const kindTarget = (() => {
    if (!normalizedChannel) {
      return id;
    }
    if (normalizedChannel === "discord" || normalizedChannel === "slack") {
      return `channel:${id}`;
    }
    return kind === "channel" ? `channel:${id}` : `group:${id}`;
  })();
  const normalized = normalizedChannel
    ? getChannelPlugin(normalizedChannel)?.messaging?.normalizeTarget?.(kindTarget)
    : undefined;
  return {
    channel,
    to: normalized ?? kindTarget,
    threadId,
  };
}

function buildAgentLabel(agentId: string, config: OpenClawConfig | undefined): string {
  if (!config) {
    return agentId;
  }
  const agentConfig = resolveAgentConfig(config, agentId);
  const rawName = agentConfig?.name;
  if (rawName) {
    // Sanitize: collapse whitespace/newlines to single spaces, strip parentheses
    const name = rawName
      .replace(/[\r\n]+/g, " ")
      .replace(/[()]/g, "")
      .trim();
    if (name) {
      return `${name} (${agentId})`;
    }
  }
  return agentId;
}

export async function buildRequesterContextSummary(
  sessionKey: string,
  limit?: number,
): Promise<string> {
  try {
    const result = await callGateway<{ messages: Array<unknown> }>({
      method: "chat.history",
      params: { sessionKey, limit: limit ?? 10 },
    });

    if (!result?.messages || !Array.isArray(result.messages)) {
      return "";
    }

    const filtered = stripToolMessages(result.messages);
    if (filtered.length === 0) {
      return "";
    }

    const messageParts: string[] = [];
    let charCount = 0;
    const maxChars = 3000;

    for (const msg of filtered) {
      if (!msg || typeof msg !== "object") {
        continue;
      }

      const role = (msg as { role?: unknown }).role;
      let content = "";

      if (role === "assistant") {
        content = extractAssistantText(msg) ?? "";
      } else if (role === "user") {
        const rawContent = (msg as { content?: unknown }).content;
        if (typeof rawContent === "string") {
          content = rawContent;
        } else if (Array.isArray(rawContent)) {
          const textParts: string[] = [];
          for (const block of rawContent) {
            if (block && typeof block === "object") {
              const text = (block as { text?: unknown }).text;
              if (typeof text === "string") {
                textParts.push(text);
              }
            }
          }
          content = textParts.join(" ");
        }
      } else {
        continue;
      }

      if (!content) {
        continue;
      }

      const truncated = content.length > 500 ? content.substring(0, 500) + "..." : content;
      const line = `[${role}]: ${truncated}`;

      if (charCount + line.length > maxChars) {
        break;
      }

      messageParts.push(line);
      charCount += line.length;
    }

    if (messageParts.length === 0) {
      return "";
    }

    return `## Requester's Recent Context\n${messageParts.join("\n")}`;
  } catch {
    return "";
  }
}

export function buildAgentToAgentMessageContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  config?: OpenClawConfig;
  requesterContextSummary?: string;
  payload?: A2APayload | null;
}) {
  const requesterAgentId = params.requesterSessionKey
    ? resolveAgentIdFromSessionKey(params.requesterSessionKey)
    : undefined;
  const targetAgentId = resolveAgentIdFromSessionKey(params.targetSessionKey);

  const requesterLabel = requesterAgentId
    ? buildAgentLabel(requesterAgentId, params.config)
    : undefined;
  const targetLabel = buildAgentLabel(targetAgentId, params.config);

  const lines = [
    "Agent-to-agent message context:",
    params.requesterSessionKey
      ? `From: ${requesterLabel}, session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel ? `From channel: ${params.requesterChannel}.` : undefined,
    `To: ${targetLabel}, session: ${params.targetSessionKey}.`,
    params.payload
      ? `
--- Structured Payload (${params.payload.type}) ---
${buildPayloadSummary(params.payload)}
---`
      : undefined,
    params.requesterContextSummary && params.requesterContextSummary.trim()
      ? params.requesterContextSummary
      : undefined,
    "",
    "**IMPORTANT**: This is an internal agent-to-agent conversation.",
    "- Use ONLY sessions_send to communicate with other agents.",
    "- NEVER use the message tool to send messages to Discord, Telegram, Slack, or any external channel for agent-to-agent communication.",
    "- If sessions_send times out or fails, report the failure — do NOT fall back to external messaging channels (Discord DM, etc.).",
    "- Do NOT mention or ping other agents on external channels.",
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildAgentToAgentReplyContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  currentRole: "requester" | "target";
  turn: number;
  maxTurns: number;
  originalMessage?: string;
  messageIntent?: string;
  previousTurnSummary?: string;
}) {
  const currentLabel =
    params.currentRole === "requester" ? "Agent 1 (requester)" : "Agent 2 (target)";
  const remainingTurns = params.maxTurns - params.turn + 1;
  const lines = [
    "## Agent-to-agent reply step",
    "",
    `**Your role**: ${currentLabel}`,
    `**Turn**: ${params.turn} of ${params.maxTurns} (${remainingTurns} remaining)`,
    params.messageIntent ? `**Conversation purpose**: ${params.messageIntent}` : undefined,
    "",
    params.originalMessage
      ? `### Original request\n${params.originalMessage.slice(0, 500)}`
      : undefined,
    params.previousTurnSummary
      ? `### Previous discussion\n${params.previousTurnSummary}`
      : undefined,
    "",
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
    "",
    "### Guidelines",
    "- Be concise and focused on the topic",
    "- If the other agent asked you questions, you MUST answer them — do NOT skip",
    "- If the other agent proposed something, share your opinion or build on it",
    "- Do NOT repeat what has already been said",
    "- Only reply REPLY_SKIP when there is genuinely nothing left to discuss (no open questions, no unresolved points)",
    "- **NEVER use the message tool to send messages to Discord, Telegram, or any external channel during this conversation**",
    "- **NEVER mention or ping other agents on external channels — this is an internal conversation**",
    "- If sessions_send times out or fails, do NOT fall back to external messaging channels",
    "",
    `To end the conversation when fully resolved, reply exactly "${REPLY_SKIP_TOKEN}".`,
  ].filter(Boolean);
  return lines.join("\n");
}

export function buildAgentToAgentAnnounceContext(params: {
  requesterSessionKey?: string;
  requesterChannel?: string;
  targetSessionKey: string;
  targetChannel?: string;
  originalMessage: string;
  roundOneReply?: string;
  latestReply?: string;
}) {
  const lines = [
    "Agent-to-agent announce step:",
    params.requesterSessionKey
      ? `Agent 1 (requester) session: ${params.requesterSessionKey}.`
      : undefined,
    params.requesterChannel
      ? `Agent 1 (requester) channel: ${params.requesterChannel}.`
      : undefined,
    `Agent 2 (target) session: ${params.targetSessionKey}.`,
    params.targetChannel ? `Agent 2 (target) channel: ${params.targetChannel}.` : undefined,
    `Original request: ${params.originalMessage}`,
    params.roundOneReply
      ? `Round 1 reply: ${params.roundOneReply}`
      : "Round 1 reply: (not available).",
    params.latestReply ? `Latest reply: ${params.latestReply}` : "Latest reply: (not available).",
    `If you want to remain silent, reply exactly "${ANNOUNCE_SKIP_TOKEN}".`,
    "Any other reply will be posted to the target channel.",
    "After this reply, the agent-to-agent conversation is over.",
    "**IMPORTANT: Do NOT use the message tool to send messages to Discord or other external channels.**",
  ].filter(Boolean);
  return lines.join("\n");
}

function isSkipToken(text: string | undefined, token: string): boolean {
  const normalized = (text ?? "").trim().toUpperCase();
  if (!normalized) {
    return false;
  }
  if (normalized === token) {
    return true;
  }
  if (normalized.startsWith(token + ".") || normalized.startsWith(token + " ")) {
    return true;
  }
  return false;
}

export function isAnnounceSkip(text?: string) {
  return isSkipToken(text, ANNOUNCE_SKIP_TOKEN);
}

export function isReplySkip(text?: string) {
  return isSkipToken(text, REPLY_SKIP_TOKEN);
}

export function resolvePingPongTurns(cfg?: OpenClawConfig) {
  const raw = cfg?.session?.agentToAgent?.maxPingPongTurns;
  const fallback = DEFAULT_PING_PONG_TURNS;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  const rounded = Math.floor(raw);
  return Math.max(0, Math.min(MAX_PING_PONG_TURNS, rounded));
}
