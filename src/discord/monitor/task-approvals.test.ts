import type { ButtonInteraction, ComponentData } from "@buape/carbon";
import { describe, expect, it, vi } from "vitest";
import type { DiscordTaskApprovalHandler } from "./task-approvals.js";
import {
  buildTaskApprovalCustomId,
  parseTaskApprovalData,
  DiscordTaskApprovalHandler as DiscordTaskApprovalHandlerClass,
  TaskApprovalButton,
} from "./task-approvals.js";

function createInteraction(
  overrides: Partial<Record<"userId" | "update" | "reply" | "followUp", unknown>> = {},
) {
  return {
    userId: "123",
    update: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as ButtonInteraction;
}

function createHandlerStub(
  overrides: Partial<Record<"isApprover" | "resolveTaskApproval", unknown>> = {},
) {
  return {
    isApprover: vi.fn((userId: string) => userId === "123"),
    resolveTaskApproval: vi.fn(async () => ({ ok: true, message: "approved" })),
    ...overrides,
  } as unknown as DiscordTaskApprovalHandler;
}

describe("buildTaskApprovalCustomId", () => {
  it("encodes agent, task, and action", () => {
    const customId = buildTaskApprovalCustomId({
      agentId: "main",
      taskId: "task_123",
      action: "approve",
    });
    expect(customId).toBe("taskapproval:agent=main;task=task_123;action=approve");
  });

  it("encodes special characters", () => {
    const customId = buildTaskApprovalCustomId({
      agentId: "ma=in;1",
      taskId: "task=12;3",
      action: "approve",
    });
    expect(customId).toBe("taskapproval:agent=ma%3Din%3B1;task=task%3D12%3B3;action=approve");
  });
});

describe("parseTaskApprovalData", () => {
  it("parses valid data", () => {
    const parsed = parseTaskApprovalData({
      agent: "main",
      task: "task_123",
      action: "approve",
    });
    expect(parsed).toEqual({
      agentId: "main",
      taskId: "task_123",
      action: "approve",
    });
  });

  it("decodes encoded values", () => {
    const parsed = parseTaskApprovalData({
      agent: "ma%3Din%3B1",
      task: "task%3D12%3B3",
      action: "approve",
    });
    expect(parsed).toEqual({
      agentId: "ma=in;1",
      taskId: "task=12;3",
      action: "approve",
    });
  });

  it("rejects invalid action", () => {
    const parsed = parseTaskApprovalData({
      agent: "main",
      task: "task_123",
      action: "deny",
    });
    expect(parsed).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(parseTaskApprovalData({ agent: "main", action: "approve" })).toBeNull();
    expect(parseTaskApprovalData({ task: "task_123", action: "approve" })).toBeNull();
    expect(parseTaskApprovalData({ agent: "main", task: "task_123" })).toBeNull();
  });

  it("rejects null or undefined input", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(parseTaskApprovalData(null as any)).toBeNull();
    // oxlint-disable-next-line typescript/no-explicit-any
    expect(parseTaskApprovalData(undefined as any)).toBeNull();
  });
});

describe("DiscordTaskApprovalHandler approver normalization", () => {
  it("normalizes approver IDs to numeric strings and removes duplicates", () => {
    const handler = new DiscordTaskApprovalHandlerClass({
      token: "token",
      accountId: "default",
      cfg: {} as never,
      approvers: ["123", 456, " 789 ", "abc", "*", "123"],
    });

    expect(handler.getApprovers()).toEqual(["123", "456", "789"]);
    expect(handler.isApprover("123")).toBe(true);
    expect(handler.isApprover("999")).toBe(false);
  });
});

describe("TaskApprovalButton", () => {
  it("rejects invalid payload data", async () => {
    const handler = createHandlerStub();
    const button = new TaskApprovalButton({ handler });
    const interaction = createInteraction();

    await button.run(interaction, { invalid: "payload" } as ComponentData);

    const update = (interaction as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(update).toHaveBeenCalledWith({
      content: "This task approval is no longer valid.",
      components: [],
    });
  });

  it("rejects non-approver users", async () => {
    const handler = createHandlerStub({
      isApprover: vi.fn(() => false),
    });
    const button = new TaskApprovalButton({ handler });
    const interaction = createInteraction({ userId: "999" });

    await button.run(interaction, {
      agent: "main",
      task: "task_123",
      action: "approve",
    } as ComponentData);

    const reply = (interaction as unknown as { reply: ReturnType<typeof vi.fn> }).reply;
    expect(reply).toHaveBeenCalledWith({
      content: "You are not authorized to approve tasks.",
      ephemeral: true,
    });
    const resolveTaskApproval = (
      handler as unknown as { resolveTaskApproval: ReturnType<typeof vi.fn> }
    ).resolveTaskApproval;
    expect(resolveTaskApproval).not.toHaveBeenCalled();
  });

  it("submits approval for authorized approver", async () => {
    const resolveTaskApproval = vi.fn(async () => ({ ok: true, message: "approved" }));
    const handler = createHandlerStub({
      isApprover: vi.fn(() => true),
      resolveTaskApproval,
    });
    const button = new TaskApprovalButton({ handler });
    const interaction = createInteraction({ userId: "123" });

    await button.run(interaction, {
      agent: "main",
      task: "task_123",
      action: "approve",
    } as ComponentData);

    expect(resolveTaskApproval).toHaveBeenCalledWith({
      agentId: "main",
      taskId: "task_123",
      approvedBy: "123",
    });
    const update = (interaction as unknown as { update: ReturnType<typeof vi.fn> }).update;
    expect(update).toHaveBeenCalledWith({
      content: "Submitting task approval...",
      components: [],
    });
  });

  it("reports follow-up error when approval fails", async () => {
    const handler = createHandlerStub({
      isApprover: vi.fn(() => true),
      resolveTaskApproval: vi.fn(async () => ({ ok: false, message: "task_approve failed" })),
    });
    const button = new TaskApprovalButton({ handler });
    const interaction = createInteraction({ userId: "123" });

    await button.run(interaction, {
      agent: "main",
      task: "task_123",
      action: "approve",
    } as ComponentData);

    const followUp = (interaction as unknown as { followUp: ReturnType<typeof vi.fn> }).followUp;
    expect(followUp).toHaveBeenCalledWith({
      content: "Failed to approve task: task_approve failed",
      ephemeral: true,
    });
  });
});
