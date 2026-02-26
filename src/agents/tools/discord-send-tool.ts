import { trackOutboundMention } from "../../discord/a2a-retry/index.js";
import { getBotUserIdForAgent } from "../../discord/monitor/sibling-bots.js";
import { sendMessageDiscord, createThreadDiscord } from "../../discord/send.js";
import { logVerbose } from "../../globals.js";

/** Discord thread names are capped at 100 characters. */
function deriveThreadName(message: string): string {
  const firstLine =
    message
      .split("\n")
      .find((l) => l.trim())
      ?.trim() ?? "";
  return (firstLine.slice(0, 97) || new Date().toISOString().slice(0, 16)) + "...";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return text.slice(0, maxLength);
}

export async function handleDiscordSend(params: {
  targetAgentId: string;
  message: string;
  threadId?: string;
  channelId?: string;
  threadName?: string;
  urgent?: boolean;
  fromAgentId?: string;
  accountId?: string;
}): Promise<{
  ok: boolean;
  messageId?: string;
  threadId?: string;
  channelId?: string;
  error?: string;
}> {
  const { targetAgentId, message, threadId, channelId, threadName, fromAgentId } = params;

  logVerbose("discord-send: resolving bot id for agent " + targetAgentId);

  const targetBotId = getBotUserIdForAgent(targetAgentId);
  if (!targetBotId) {
    return { ok: false, error: "Target agent has no registered Discord bot" };
  }

  const mention = `<@${targetBotId}>`;
  const fullContent = `${mention}\n\n${message}`;

  try {
    if (threadId) {
      logVerbose("discord-send: sending to existing thread " + threadId);
      const result = await sendMessageDiscord(`channel:${threadId}`, fullContent);
      const messageId = result.messageId;
      const resolvedThreadId = threadId;

      try {
        await trackOutboundMention({
          messageId,
          threadId: resolvedThreadId,
          fromAgentId: fromAgentId ?? "unknown",
          targetAgentId,
          targetBotId,
          originalText: truncateText(message, 500),
        });
        logVerbose("discord-send: tracked outbound mention to " + targetAgentId);
      } catch (trackErr) {
        logVerbose("discord-send: failed to track outbound mention: " + String(trackErr));
      }

      return { ok: true, messageId, threadId: resolvedThreadId };
    }

    if (!channelId) {
      return {
        ok: false,
        error: "Either threadId or channelId is required to send a Discord message",
      };
    }

    logVerbose("discord-send: creating thread in channel " + channelId);
    const name = threadName || deriveThreadName(message);
    const thread = await createThreadDiscord(channelId, { name, content: fullContent });
    const resolvedThreadId = thread.id;
    const messageId = thread.id;

    try {
      await trackOutboundMention({
        messageId,
        threadId: resolvedThreadId,
        fromAgentId: fromAgentId ?? "unknown",
        targetAgentId,
        targetBotId,
        originalText: truncateText(message, 500),
      });
      logVerbose("discord-send: tracked outbound mention to " + targetAgentId);
    } catch (trackErr) {
      logVerbose("discord-send: failed to track outbound mention: " + String(trackErr));
    }

    return { ok: true, messageId, threadId: resolvedThreadId, channelId };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logVerbose("discord-send: error sending message: " + errorMessage);
    return { ok: false, error: errorMessage };
  }
}
