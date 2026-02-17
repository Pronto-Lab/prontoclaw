import type { MsgContext } from "../auto-reply/templating.js";
import { normalizeChatType } from "./chat-type.js";
import { maskConversationTitleOrPreview } from "./sensitive-mask.js";

function extractConversationId(from?: string): string | undefined {
  const trimmed = from?.trim();
  if (!trimmed) {
    return undefined;
  }
  const parts = trimmed.split(":").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : trimmed;
}

function shouldAppendId(id: string): boolean {
  if (/^[0-9]+$/.test(id)) {
    return true;
  }
  if (id.includes("@g.us")) {
    return true;
  }
  return false;
}

function maskLabel(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return maskConversationTitleOrPreview(trimmed);
}

export function resolveConversationLabel(ctx: MsgContext): string | undefined {
  const explicit = maskLabel(ctx.ConversationLabel);
  if (explicit) {
    return explicit;
  }

  const threadLabel = maskLabel(ctx.ThreadLabel);
  if (threadLabel) {
    return threadLabel;
  }

  const chatType = normalizeChatType(ctx.ChatType);
  if (chatType === "direct") {
    return maskLabel(ctx.SenderName) || maskLabel(ctx.From) || undefined;
  }

  const base =
    maskLabel(ctx.GroupChannel) ||
    maskLabel(ctx.GroupSubject) ||
    maskLabel(ctx.GroupSpace) ||
    maskLabel(ctx.From) ||
    "";
  if (!base) {
    return undefined;
  }

  const id = extractConversationId(ctx.From);
  if (!id) {
    return base;
  }
  if (!shouldAppendId(id)) {
    return base;
  }
  if (base === id) {
    return base;
  }
  if (base.includes(id)) {
    return base;
  }
  if (base.toLowerCase().includes(" id:")) {
    return base;
  }
  if (base.startsWith("#") || base.startsWith("@")) {
    return base;
  }
  return maskConversationTitleOrPreview(`${base} id:${id}`);
}
