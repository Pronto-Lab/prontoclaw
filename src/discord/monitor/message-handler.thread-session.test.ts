import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchInboundMessage = vi.fn(async () => ({
  queuedFinal: false,
  counts: { final: 0, tool: 0, block: 0 },
}));

vi.mock("../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: (...args: unknown[]) => dispatchInboundMessage(...args),
}));

vi.mock("../send.js", () => ({
  reactMessageDiscord: vi.fn(async () => {}),
  removeReactionDiscord: vi.fn(async () => {}),
}));

vi.mock("../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcherWithTyping: vi.fn(() => ({
    dispatcher: {
      sendToolResult: vi.fn(() => true),
      sendBlockReply: vi.fn(() => true),
      sendFinalReply: vi.fn(() => true),
      waitForIdle: vi.fn(async () => {}),
      getQueuedCounts: vi.fn(() => ({ tool: 0, block: 0, final: 0 })),
      markComplete: vi.fn(),
    },
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  })),
}));

const { processDiscordMessage } = await import("./message-handler.process.js");

async function createBaseContext(overrides: Record<string, unknown> = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-discord-thread-"));
  const storePath = path.join(dir, "sessions.json");
  return {
    cfg: { messages: {}, session: { store: storePath } },
    discordConfig: {},
    accountId: "default",
    token: "token",
    runtime: { log: () => {}, error: () => {} },
    guildHistories: new Map(),
    historyLimit: 0,
    mediaMaxBytes: 1024,
    textLimit: 4000,
    replyToMode: "off",
    ackReactionScope: "group-mentions",
    groupPolicy: "open",
    data: { guild: { id: "g1", name: "Guild" }, member: { nickname: "Nick" } },
    client: { rest: {} },
    message: {
      id: "m1",
      channelId: "thread123",
      timestamp: new Date().toISOString(),
      attachments: [],
    },
    author: {
      id: "U1",
      username: "alice",
      discriminator: "0",
      globalName: "Alice",
    },
    sender: { id: "U1", label: "user", isPluralKit: false },
    channelInfo: { name: "thread-name" },
    channelName: "thread-name",
    isGuildMessage: true,
    isDirectMessage: false,
    isGroupDm: false,
    commandAuthorized: true,
    baseText: "hello",
    messageText: "hello",
    wasMentioned: false,
    shouldRequireMention: false,
    canDetectMention: true,
    effectiveWasMentioned: false,
    shouldBypassMention: false,
    threadChannel: { id: "thread123", name: "Thread Name" },
    threadParentId: "parent456",
    threadParentName: "general",
    threadParentType: undefined,
    threadName: "Thread Name",
    displayChannelSlug: "thread-name",
    guildInfo: null,
    guildSlug: "guild",
    channelConfig: null,
    baseSessionKey: "agent:main:discord:channel:thread123",
    route: {
      agentId: "main",
      channel: "discord",
      accountId: "default",
      sessionKey: "agent:main:discord:channel:thread123",
      mainSessionKey: "agent:main:main",
    },
    ...overrides,
  };
}

beforeEach(() => {
  dispatchInboundMessage.mockClear();
});

describe("processDiscordMessage thread session keys", () => {
  it("keeps Discord thread session as channel peer key and carries parent session key", async () => {
    const ctx = await createBaseContext();

    // oxlint-disable-next-line typescript/no-explicit-any
    await processDiscordMessage(ctx as any);

    expect(dispatchInboundMessage).toHaveBeenCalledTimes(1);
    const call = dispatchInboundMessage.mock.calls[0] as [{ ctx: Record<string, unknown> }];
    const inboundCtx = call[0].ctx;

    expect(inboundCtx.SessionKey).toBe("agent:main:discord:channel:thread123");
    expect(inboundCtx.ParentSessionKey).toBe("agent:main:discord:channel:parent456");
    expect(String(inboundCtx.SessionKey)).not.toContain(":thread:");
  });
});
