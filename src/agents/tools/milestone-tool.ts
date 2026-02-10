import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const TASK_HUB_URL = process.env.TASK_HUB_URL || "http://localhost:3102";

async function hubFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${TASK_HUB_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  return res.json();
}

export function createMilestoneTools(): AnyAgentTool[] {
  const milestoneList: AnyAgentTool = {
    name: "milestone_list",
    description:
      "List all milestones with progress. Use to get an overview of project milestones, their status, progress, and team assignments.",
    schema: Type.Object({
      status: Type.Optional(
        Type.Union([
          Type.Literal("active"),
          Type.Literal("planning"),
          Type.Literal("completed"),
          Type.Literal("all"),
        ]),
      ),
    }),
    handler: async (args) => {
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
    description:
      "Create a new milestone. Requires title and targetDate. Optionally set description, dependsOn (array of milestone IDs), and teamAssignments.",
    schema: Type.Object({
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
    handler: async (args) => {
      const data = await hubFetch("/api/milestones", {
        method: "POST",
        body: JSON.stringify(args),
      });
      return jsonResult(data);
    },
  };

  const milestoneAddItem: AnyAgentTool = {
    name: "milestone_add_item",
    description:
      "Add an item to a milestone. Specify milestoneId, title, and optionally priority, assigneeTeam, assigneeAgent, dueDate.",
    schema: Type.Object({
      milestoneId: Type.String(),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      priority: Type.Optional(
        Type.Union([Type.Literal("high"), Type.Literal("medium"), Type.Literal("low")]),
      ),
      assigneeTeam: Type.Optional(Type.String()),
      assigneeAgent: Type.Optional(Type.String()),
      dueDate: Type.Optional(Type.String()),
    }),
    handler: async (args) => {
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
    description:
      "Assign a milestone item to an agent. Creates a backlog task or todo and links it to the item. Use createAs='backlog' for agent tasks, createAs='todo' for user-facing todos.",
    schema: Type.Object({
      milestoneId: Type.String(),
      itemId: Type.String(),
      agentId: Type.String(),
      createAs: Type.Union([Type.Literal("backlog"), Type.Literal("todo")]),
      context: Type.Optional(Type.String()),
    }),
    handler: async (args) => {
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
    description:
      "Update a milestone item's status, title, assignee, or priority. Use to mark items done, change assignments, etc.",
    schema: Type.Object({
      milestoneId: Type.String(),
      itemId: Type.String(),
      status: Type.Optional(Type.String()),
      title: Type.Optional(Type.String()),
      assigneeAgent: Type.Optional(Type.String()),
      assigneeTeam: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
    }),
    handler: async (args) => {
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
