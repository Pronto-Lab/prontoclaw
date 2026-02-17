import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const TASK_HUB_URL = process.env.TASK_HUB_URL || "http://localhost:3102";

async function hubFetch(path: string, options?: RequestInit) {
  const optionHeaders =
    options?.headers instanceof Headers
      ? Object.fromEntries(options.headers.entries())
      : Array.isArray(options?.headers)
        ? Object.fromEntries(options.headers)
        : options?.headers;
  const res = await fetch(`${TASK_HUB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Cookie: "task-hub-session=authenticated",
      ...optionHeaders,
    },
  });
  return res.json();
}

export function createMilestoneTools(): AnyAgentTool[] {
  const milestoneList: AnyAgentTool = {
    name: "milestone_list",
    label: "List Milestones",
    description:
      "List all milestones with progress. Use to get an overview of project milestones, their status, progress, and team assignments.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Unsafe<string>({ type: "string", enum: ["active", "planning", "completed", "all"] }),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const data = await hubFetch("/api/milestones");
      const status = readStringParam(args, "status") || "all";
      let milestones = data.milestones || [];
      if (status !== "all") {
        milestones = milestones.filter((m: { status: string }) => m.status === status);
      }
      return jsonResult({ milestones, count: milestones.length });
    },
  };

  const milestoneCreate: AnyAgentTool = {
    name: "milestone_create",
    label: "Create Milestone",
    description:
      "Create a new milestone. Requires title and targetDate. Optionally set description, dependsOn (array of milestone IDs), and teamAssignments.",
    parameters: Type.Object({
      title: Type.String(),
      description: Type.Optional(Type.String()),
      targetDate: Type.String(),
      status: Type.Optional(Type.String()),
      dependsOn: Type.Optional(Type.Array(Type.String())),
      teamAssignments: Type.Optional(
        Type.Array(
          Type.Object({
            teamId: Type.String(),
            role: Type.Optional(Type.String()),
          }),
        ),
      ),
    }),
    execute: async (_toolCallId, args) => {
      const data = await hubFetch("/api/milestones", {
        method: "POST",
        body: JSON.stringify(args),
      });
      return jsonResult(data);
    },
  };

  const milestoneAddItem: AnyAgentTool = {
    name: "milestone_add_item",
    label: "Add Milestone Item",
    description:
      "Add an item to a milestone. Specify milestoneId, title, and optionally priority, assigneeTeam, assigneeAgent, dueDate.",
    parameters: Type.Object({
      milestoneId: Type.String(),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Unsafe<string>({ type: "string", enum: ["high", "medium", "low"] }),
      ),
      assigneeTeam: Type.Optional(Type.String()),
      assigneeAgent: Type.Optional(Type.String()),
      dueDate: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const milestoneId = readStringParam(args, "milestoneId");
      const body = { ...args };
      delete (body as Record<string, unknown>).milestoneId;
      const data = await hubFetch(`/api/milestones/${milestoneId}/items`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return jsonResult(data);
    },
  };

  const milestoneAssignItem: AnyAgentTool = {
    name: "milestone_assign_item",
    label: "Assign Milestone Item",
    description:
      "Assign a milestone item to an agent. Creates a backlog task or todo and links it to the item. Use createAs='backlog' for agent tasks, createAs='todo' for user-facing todos.",
    parameters: Type.Object({
      milestoneId: Type.String(),
      itemId: Type.String(),
      agentId: Type.String(),
      createAs: Type.Unsafe<string>({ type: "string", enum: ["backlog", "todo"] }),
      context: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const milestoneId = readStringParam(args, "milestoneId");
      const itemId = readStringParam(args, "itemId");
      const agentId = readStringParam(args, "agentId");
      const createAs = readStringParam(args, "createAs") || "backlog";

      const itemRes = await hubFetch(`/api/milestones/${milestoneId}/items`);
      const items = itemRes.items || [];
      const item = items.find((i: { _id: string }) => i._id === itemId);
      if (!item) {
        return jsonResult({ error: `Item ${itemId} not found in milestone ${milestoneId}` });
      }

      const updateData: Record<string, unknown> = {
        assigneeAgent: agentId,
        status: "in_progress",
      };

      if (createAs === "backlog") {
        updateData.linkedTaskRef = { agentId, taskId: `pending_${itemId}` };
      }

      const data = await hubFetch(`/api/milestones/${milestoneId}/items/${itemId}`, {
        method: "PUT",
        body: JSON.stringify(updateData),
      });
      return jsonResult({
        ...data,
        assigned: true,
        agentId,
        createAs,
        note:
          createAs === "backlog"
            ? `Item assigned to ${agentId}. Use task_backlog_add to create the actual task, then update the linkedTaskRef with the real taskId.`
            : `Item assigned to ${agentId} as todo.`,
      });
    },
  };

  const milestoneUpdateItem: AnyAgentTool = {
    name: "milestone_update_item",
    label: "Update Milestone Item",
    description:
      "Update a milestone item's status, title, assignee, or priority. Use to mark items done, change assignments, etc.",
    parameters: Type.Object({
      milestoneId: Type.String(),
      itemId: Type.String(),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      assigneeAgent: Type.Optional(Type.String()),
      assigneeTeam: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
    }),
    execute: async (_toolCallId, args) => {
      const milestoneId = readStringParam(args, "milestoneId");
      const itemId = readStringParam(args, "itemId");
      const body = { ...args };
      delete (body as Record<string, unknown>).milestoneId;
      delete (body as Record<string, unknown>).itemId;
      const data = await hubFetch(`/api/milestones/${milestoneId}/items/${itemId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      return jsonResult(data);
    },
  };

  return [
    milestoneList,
    milestoneCreate,
    milestoneAddItem,
    milestoneAssignItem,
    milestoneUpdateItem,
  ];
}
