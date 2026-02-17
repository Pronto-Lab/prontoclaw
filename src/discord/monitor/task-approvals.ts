import { Button, type ButtonInteraction, type ComponentData } from "@buape/carbon";
import { ButtonStyle, Routes } from "discord-api-types/v10";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { createTaskApproveTool, readTask } from "../../agents/tools/task-tool.js";
import { resolveAgentMainSessionKey } from "../../config/sessions.js";
import { subscribe, type CoordinationEvent } from "../../infra/events/bus.js";
import { EVENT_TYPES } from "../../infra/events/schemas.js";
import { logDebug, logError } from "../../logger.js";
import { createDiscordClient } from "../send.shared.js";

const TASK_APPROVAL_KEY = "taskapproval";

type TaskApprovalAction = "approve";

type PendingMessage = {
  channelId: string;
  messageId: string;
};

type PendingTaskApproval = {
  agentId: string;
  taskId: string;
  workSessionId?: string;
  messages: PendingMessage[];
};

function encodeCustomIdValue(value: string): string {
  return encodeURIComponent(value);
}

function decodeCustomIdValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function buildTaskApprovalCustomId(params: {
  agentId: string;
  taskId: string;
  action: TaskApprovalAction;
}): string {
  return [
    `${TASK_APPROVAL_KEY}:agent=${encodeCustomIdValue(params.agentId)}`,
    `task=${encodeCustomIdValue(params.taskId)}`,
    `action=${params.action}`,
  ].join(";");
}

export function parseTaskApprovalData(
  data: ComponentData,
): { agentId: string; taskId: string; action: TaskApprovalAction } | null {
  if (!data || typeof data !== "object") {
    return null;
  }
  const coerce = (value: unknown) =>
    typeof value === "string" || typeof value === "number" ? String(value) : "";
  const rawAgent = coerce(data.agent);
  const rawTask = coerce(data.task);
  const rawAction = coerce(data.action);
  if (!rawAgent || !rawTask || !rawAction) {
    return null;
  }
  if (rawAction !== "approve") {
    return null;
  }
  return {
    agentId: decodeCustomIdValue(rawAgent),
    taskId: decodeCustomIdValue(rawTask),
    action: rawAction,
  };
}

function toTaskApprovalKey(agentId: string, taskId: string): string {
  return `${agentId}::${taskId}`;
}

function resolveTaskHubUrl(
  baseUrl: string | undefined,
  params: { agentId: string; taskId: string; workSessionId?: string },
) {
  if (!baseUrl || !baseUrl.trim()) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    url.pathname = "/tasks";
    url.searchParams.set("agentId", params.agentId);
    url.searchParams.set("taskId", params.taskId);
    if (params.workSessionId) {
      url.searchParams.set("workSessionId", params.workSessionId);
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function extractPendingTaskFromEvent(
  event: CoordinationEvent,
): { agentId: string; taskId: string; workSessionId?: string; priority?: string } | null {
  if (event.type !== EVENT_TYPES.TASK_STARTED) {
    return null;
  }
  const requiresApproval = event.data?.requiresApproval === true;
  if (!requiresApproval) {
    return null;
  }
  const taskId = typeof event.data?.taskId === "string" ? event.data.taskId.trim() : "";
  if (!taskId) {
    return null;
  }
  const agentId = typeof event.agentId === "string" ? event.agentId.trim() : "";
  if (!agentId) {
    return null;
  }
  const workSessionId =
    typeof event.data?.workSessionId === "string" ? event.data.workSessionId : undefined;
  const priority = typeof event.data?.priority === "string" ? event.data.priority : undefined;
  return { agentId, taskId, workSessionId, priority };
}

function parseTaskApproveDetails(details: unknown): {
  success: boolean;
  error?: string;
} {
  if (!details || typeof details !== "object") {
    return { success: false, error: "Invalid task_approve response" };
  }
  const payload = details as { success?: unknown; error?: unknown };
  const success = payload.success === true;
  const error = typeof payload.error === "string" ? payload.error : undefined;
  return { success, error };
}

function normalizeApproverIds(entries: Array<string | number>): string[] {
  const ids = new Set<string>();
  for (const entry of entries) {
    const candidate = String(entry).trim();
    if (!candidate || candidate === "*") {
      continue;
    }
    if (!/^\d+$/.test(candidate)) {
      continue;
    }
    ids.add(candidate);
  }
  return Array.from(ids);
}

function formatPendingEmbed(params: {
  agentId: string;
  taskId: string;
  workSessionId?: string;
  priority?: string;
  description?: string;
}) {
  const fields: Array<{ name: string; value: string; inline: boolean }> = [
    {
      name: "Task ID",
      value: params.taskId,
      inline: true,
    },
    {
      name: "Agent",
      value: params.agentId,
      inline: true,
    },
  ];
  if (params.priority) {
    fields.push({
      name: "Priority",
      value: params.priority,
      inline: true,
    });
  }
  if (params.workSessionId) {
    fields.push({
      name: "Work Session",
      value: params.workSessionId,
      inline: false,
    });
  }
  if (params.description) {
    fields.push({
      name: "Description",
      value: params.description.slice(0, 900),
      inline: false,
    });
  }
  return {
    title: "Task Approval Required",
    description: "A task is waiting for human approval before work begins.",
    color: 0xf59e0b,
    fields,
    timestamp: new Date().toISOString(),
  };
}

function formatResolvedEmbed(params: {
  agentId: string;
  taskId: string;
  approvedBy: string;
  alreadyApproved?: boolean;
}) {
  return {
    title: params.alreadyApproved ? "Task Already Approved" : "Task Approved",
    description: params.alreadyApproved
      ? `Task was already approved. (by click: ${params.approvedBy})`
      : `Approved by ${params.approvedBy}`,
    color: params.alreadyApproved ? 0x60a5fa : 0x22c55e,
    fields: [
      { name: "Task ID", value: params.taskId, inline: true },
      { name: "Agent", value: params.agentId, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

function formatFailedEmbed(params: { agentId: string; taskId: string; reason: string }) {
  return {
    title: "Task Approval Failed",
    description: params.reason.slice(0, 500),
    color: 0xef4444,
    fields: [
      { name: "Task ID", value: params.taskId, inline: true },
      { name: "Agent", value: params.agentId, inline: true },
    ],
    timestamp: new Date().toISOString(),
  };
}

export type DiscordTaskApprovalHandlerOpts = {
  token: string;
  accountId: string;
  cfg: OpenClawConfig;
  approvers: Array<string | number>;
  taskHubUrl?: string;
};

export class DiscordTaskApprovalHandler {
  private opts: DiscordTaskApprovalHandlerOpts;
  private started = false;
  private unsubscribe: (() => void) | null = null;
  private pending = new Map<string, PendingTaskApproval>();
  private approverIds: string[];

  constructor(opts: DiscordTaskApprovalHandlerOpts) {
    this.opts = opts;
    this.approverIds = normalizeApproverIds(opts.approvers);
  }

  getApprovers(): string[] {
    return [...this.approverIds];
  }

  isApprover(userId: string): boolean {
    return this.approverIds.includes(userId);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    if (this.approverIds.length === 0) {
      logDebug("discord task approvals: no approvers configured; handler disabled");
      return;
    }
    this.unsubscribe = subscribe(EVENT_TYPES.TASK_STARTED, (event) => {
      void this.handleTaskStarted(event);
    });
    logDebug("discord task approvals: handler started");
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }
    this.started = false;
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.pending.clear();
    logDebug("discord task approvals: handler stopped");
  }

  private async handleTaskStarted(event: CoordinationEvent): Promise<void> {
    const pendingTask = extractPendingTaskFromEvent(event);
    if (!pendingTask) {
      return;
    }

    const pendingKey = toTaskApprovalKey(pendingTask.agentId, pendingTask.taskId);
    if (this.pending.has(pendingKey)) {
      return;
    }

    let description: string | undefined;
    try {
      const workspaceDir = resolveAgentWorkspaceDir(this.opts.cfg, pendingTask.agentId);
      const task = await readTask(workspaceDir, pendingTask.taskId);
      description = task?.description;
    } catch {
      description = undefined;
    }

    const embed = formatPendingEmbed({
      agentId: pendingTask.agentId,
      taskId: pendingTask.taskId,
      workSessionId: pendingTask.workSessionId,
      priority: pendingTask.priority,
      description,
    });

    const taskHubLink = resolveTaskHubUrl(this.opts.taskHubUrl, pendingTask);
    const components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: ButtonStyle.Success,
            label: "Approve Task",
            custom_id: buildTaskApprovalCustomId({
              agentId: pendingTask.agentId,
              taskId: pendingTask.taskId,
              action: "approve",
            }),
          },
          ...(taskHubLink
            ? [
                {
                  type: 2,
                  style: ButtonStyle.Link,
                  label: "Open Task Hub",
                  url: taskHubLink,
                },
              ]
            : []),
        ],
      },
    ];

    const { rest, request } = createDiscordClient(
      { token: this.opts.token, accountId: this.opts.accountId },
      this.opts.cfg,
    );

    const sentMessages: PendingMessage[] = [];
    for (const approverId of this.approverIds) {
      try {
        const dmChannel = (await request(
          () =>
            rest.post(Routes.userChannels(), {
              body: { recipient_id: approverId },
            }) as Promise<{ id: string }>,
          "task-approval-dm-channel",
        )) as { id: string };

        if (!dmChannel?.id) {
          continue;
        }

        const message = (await request(
          () =>
            rest.post(Routes.channelMessages(dmChannel.id), {
              body: {
                embeds: [embed],
                components,
              },
            }) as Promise<{ id: string; channel_id: string }>,
          "task-approval-send",
        )) as { id: string; channel_id: string };

        if (message?.id && message?.channel_id) {
          sentMessages.push({
            channelId: message.channel_id,
            messageId: message.id,
          });
        }
      } catch (err) {
        logError(`discord task approvals: failed to notify approver ${approverId}: ${String(err)}`);
      }
    }

    if (sentMessages.length === 0) {
      return;
    }

    this.pending.set(pendingKey, {
      agentId: pendingTask.agentId,
      taskId: pendingTask.taskId,
      workSessionId: pendingTask.workSessionId,
      messages: sentMessages,
    });
  }

  async resolveTaskApproval(params: {
    agentId: string;
    taskId: string;
    approvedBy: string;
  }): Promise<{ ok: boolean; message?: string }> {
    const key = toTaskApprovalKey(params.agentId, params.taskId);
    const pending = this.pending.get(key);
    const approval = await this.approveTask({
      agentId: params.agentId,
      taskId: params.taskId,
    });

    if (!approval.ok) {
      if (pending) {
        await this.updatePendingMessages(
          pending,
          formatFailedEmbed({
            agentId: params.agentId,
            taskId: params.taskId,
            reason: approval.message ?? "Unknown error",
          }),
        );
        this.pending.delete(key);
      }
      return approval;
    }

    if (pending) {
      await this.updatePendingMessages(
        pending,
        formatResolvedEmbed({
          agentId: params.agentId,
          taskId: params.taskId,
          approvedBy: params.approvedBy,
          alreadyApproved: approval.alreadyApproved,
        }),
      );
      this.pending.delete(key);
    }

    return { ok: true, message: approval.alreadyApproved ? "already approved" : "approved" };
  }

  private async approveTask(params: {
    agentId: string;
    taskId: string;
  }): Promise<{ ok: boolean; message?: string; alreadyApproved?: boolean }> {
    const sessionKey = resolveAgentMainSessionKey({
      cfg: this.opts.cfg,
      agentId: params.agentId,
    });
    const tool = createTaskApproveTool({
      config: this.opts.cfg,
      agentSessionKey: sessionKey,
    });
    if (!tool) {
      return { ok: false, message: "task_approve tool unavailable" };
    }

    try {
      const result = await tool.execute(`discord-task-approve-${Date.now()}`, {
        task_id: params.taskId,
      });
      const parsed = parseTaskApproveDetails((result as { details?: unknown }).details);
      if (parsed.success) {
        return { ok: true };
      }
      if (parsed.error && /not pending approval/i.test(parsed.error)) {
        return { ok: true, alreadyApproved: true, message: parsed.error };
      }
      return { ok: false, message: parsed.error ?? "task_approve failed" };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async updatePendingMessages(
    pending: PendingTaskApproval,
    embed: ReturnType<typeof formatResolvedEmbed> | ReturnType<typeof formatFailedEmbed>,
  ): Promise<void> {
    const { rest, request } = createDiscordClient(
      { token: this.opts.token, accountId: this.opts.accountId },
      this.opts.cfg,
    );

    for (const message of pending.messages) {
      try {
        await request(
          () =>
            rest.patch(Routes.channelMessage(message.channelId, message.messageId), {
              body: {
                embeds: [embed],
                components: [],
              },
            }),
          "task-approval-update",
        );
      } catch (err) {
        logError(
          `discord task approvals: failed to update message ${message.messageId}: ${String(err)}`,
        );
      }
    }
  }
}

export type TaskApprovalButtonContext = {
  handler: DiscordTaskApprovalHandler;
};

export class TaskApprovalButton extends Button {
  label = TASK_APPROVAL_KEY;
  customId = `${TASK_APPROVAL_KEY}:seed=1`;
  style = ButtonStyle.Success;
  private ctx: TaskApprovalButtonContext;

  constructor(ctx: TaskApprovalButtonContext) {
    super();
    this.ctx = ctx;
  }

  async run(interaction: ButtonInteraction, data: ComponentData): Promise<void> {
    const parsed = parseTaskApprovalData(data);
    if (!parsed) {
      try {
        await interaction.update({
          content: "This task approval is no longer valid.",
          components: [],
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    const userId = interaction.userId ?? "";
    if (!this.ctx.handler.isApprover(userId)) {
      try {
        await interaction.reply({
          content: "You are not authorized to approve tasks.",
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
      return;
    }

    try {
      await interaction.update({
        content: "Submitting task approval...",
        components: [],
      });
    } catch {
      // Interaction may have expired
    }

    const result = await this.ctx.handler.resolveTaskApproval({
      agentId: parsed.agentId,
      taskId: parsed.taskId,
      approvedBy: userId,
    });

    if (!result.ok) {
      try {
        await interaction.followUp({
          content: `Failed to approve task: ${result.message ?? "Unknown error"}`,
          ephemeral: true,
        });
      } catch {
        // Interaction may have expired
      }
    }
  }
}

export function createTaskApprovalButton(ctx: TaskApprovalButtonContext): Button {
  return new TaskApprovalButton(ctx);
}
