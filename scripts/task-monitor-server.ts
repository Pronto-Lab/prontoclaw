#!/usr/bin/env bun
/**
 * Task Monitor API Server
 *
 * Standalone HTTP + WebSocket server for real-time task monitoring.
 * Exposes REST API endpoints and WebSocket for live updates.
 *
 * Usage:
 *   bun scripts/task-monitor-server.ts [--port 3847] [--host 0.0.0.0]
 *   TASK_MONITOR_PORT=3847 bun scripts/task-monitor-server.ts
 *
 * API Endpoints:
 *   GET /api/agents                    - List all agents
 *   GET /api/agents/:agentId/tasks     - Get tasks for an agent
 *   GET /api/agents/:agentId/current   - Get current task status
 *   GET /api/agents/:agentId/history   - Get task history
 *   GET /api/agents/:agentId/blocked   - Get blocked tasks with details
 *   GET /api/health                    - Health check
 *
 * WebSocket:
 *   ws://host:port/ws                  - Real-time task change notifications
 */

import chokidar from "chokidar";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_PORT = 3847;
const DEFAULT_HOST = "0.0.0.0";

// Parse CLI args
function parseArgs(): { port: number; host: string } {
  const args = process.argv.slice(2);
  let port = Number(process.env.TASK_MONITOR_PORT) || DEFAULT_PORT;
  let host = process.env.TASK_MONITOR_HOST || DEFAULT_HOST;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) {
      port = Number(args[i + 1]);
      i++;
    } else if (args[i] === "--host" && args[i + 1]) {
      host = args[i + 1];
      i++;
    }
  }

  return { port, host };
}

// ============================================================================
// Types
// ============================================================================

type TaskStatus =
  | "pending"
  | "pending_approval"
  | "in_progress"
  | "blocked"
  | "backlog"
  | "completed"
  | "cancelled"
  | "abandoned";
type TaskPriority = "low" | "medium" | "high" | "urgent";
type EscalationState = "none" | "requesting" | "escalated" | "failed";

interface TaskFile {
  id: string;
  status: TaskStatus;
  priority: TaskPriority;
  description: string;
  context?: string;
  source?: string;
  created: string;
  lastActivity: string;
  progress: string[];
  // Blocked task fields
  blockedReason?: string;
  unblockedBy?: string[];
  unblockedAction?: string;
  unblockRequestCount?: number;
  escalationState?: EscalationState;
  lastUnblockerIndex?: number;
  lastUnblockRequestAt?: string;
  unblockRequestFailures?: number;
  // Backlog task fields
  createdBy?: string;
  assignee?: string;
  dependsOn?: string[];
  estimatedEffort?: string;
  startDate?: string;
  dueDate?: string;
  // Outcome (terminal state)
  outcome?: { kind: string; summary?: string; reason?: string };
  steps?: MonitorTaskStep[];
  stepsProgress?: {
    total: number;
    done: number;
    inProgress: number;
    pending: number;
    skipped: number;
  };
}

interface MonitorTaskStep {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "skipped";
  order: number;
}

interface AgentInfo {
  id: string;
  workspaceDir: string;
  hasCurrentTask: boolean;
  taskCount: number;
}

interface CurrentTaskInfo {
  agentId: string;
  hasTask: boolean;
  content: string | null;
  taskSummary: string | null;
}

interface WsMessage {
  type:
    | "agent_update"
    | "task_update"
    | "task_step_update"
    | "connected"
    | "team_state_update"
    | "event_log"
    | "plan_update";
  agentId?: string;
  taskId?: string;
  timestamp: string;
  data?: unknown;
}

// ============================================================================
// Paths
// ============================================================================

const OPENCLAW_DIR = path.join(os.homedir(), ".openclaw");
const WORKSPACE_PREFIX = "workspace-";
const TASKS_DIR = "tasks";
const TASK_HISTORY_DIR = "task-history";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";

// ============================================================================
// Task Parsing (adapted from task-tool.ts)
// ============================================================================

function parseTaskFileMd(content: string, filename: string): TaskFile | null {
  if (!content || content.includes("*(No task)*")) {
    return null;
  }

  const idMatch = filename.match(/^(task_[a-z0-9_]+)\.md$/);
  const id = idMatch ? idMatch[1] : filename.replace(".md", "");

  const lines = content.split("\n");
  let status: TaskStatus = "pending";
  let priority: TaskPriority = "medium";
  let description = "";
  let context: string | undefined;
  let source: string | undefined;
  let created = "";
  let lastActivity = "";
  const progress: string[] = [];
  const steps: MonitorTaskStep[] = [];
  // Blocked task fields
  let blockedReason: string | undefined;
  let unblockedBy: string[] | undefined;
  let unblockedAction: string | undefined;
  let unblockRequestCount: number | undefined;
  let escalationState: EscalationState | undefined;
  let lastUnblockerIndex: number | undefined;
  let lastUnblockRequestAt: string | undefined;
  let unblockRequestFailures: number | undefined;
  // Backlog task fields
  let createdBy: string | undefined;
  let assignee: string | undefined;
  let dependsOn: string[] | undefined;
  let estimatedEffort: string | undefined;
  let startDate: string | undefined;
  let dueDate: string | undefined;
  let outcome: { kind: string; summary?: string; reason?: string } | undefined;

  let currentSection = "";

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("## ")) {
      currentSection = trimmed.slice(3).toLowerCase();
      continue;
    }

    if (trimmed.startsWith("# Task:")) {
      continue;
    }

    if (trimmed.startsWith("---") || trimmed.startsWith("*Managed by")) {
      continue;
    }

    if (!trimmed) {
      continue;
    }

    if (currentSection === "metadata") {
      const statusMatch = trimmed.match(/^-?\s*\*\*Status:\*\*\s*(.+)$/);
      if (statusMatch) {
        status = statusMatch[1] as TaskStatus;
      }
      const priorityMatch = trimmed.match(/^-?\s*\*\*Priority:\*\*\s*(.+)$/);
      if (priorityMatch) {
        priority = priorityMatch[1] as TaskPriority;
      }
      const createdMatch = trimmed.match(/^-?\s*\*\*Created:\*\*\s*(.+)$/);
      if (createdMatch) {
        created = createdMatch[1];
      }
      const sourceMatch = trimmed.match(/^-?\s*\*\*Source:\*\*\s*(.+)$/);
      if (sourceMatch) {
        source = sourceMatch[1];
      }
      // Blocked task field parsers
      const blockedReasonMatch = trimmed.match(/^-?\s*\*\*Blocked Reason:\*\*\s*(.+)$/);
      if (blockedReasonMatch) {
        blockedReason = blockedReasonMatch[1];
      }
      const unblockedByMatch = trimmed.match(/^-?\s*\*\*Unblocked By:\*\*\s*(.+)$/);
      if (unblockedByMatch) {
        unblockedBy = unblockedByMatch[1]
          .split(/,\s*/)
          .map((s) => s.trim())
          .filter(Boolean);
      }
      const unblockedActionMatch = trimmed.match(/^-?\s*\*\*Unblocked Action:\*\*\s*(.+)$/);
      if (unblockedActionMatch) {
        unblockedAction = unblockedActionMatch[1];
      }
      const unblockRequestCountMatch = trimmed.match(
        /^-?\s*\*\*Unblock Request Count:\*\*\s*(\d+)$/,
      );
      if (unblockRequestCountMatch) {
        unblockRequestCount = parseInt(unblockRequestCountMatch[1], 10);
      }
      const escalationStateMatch = trimmed.match(/^-?\s*\*\*Escalation State:\*\*\s*(.+)$/);
      if (escalationStateMatch) {
        escalationState = escalationStateMatch[1] as EscalationState;
      }
      const lastUnblockerIndexMatch = trimmed.match(
        /^-?\s*\*\*Last Unblocker Index:\*\*\s*(-?\d+)$/,
      );
      if (lastUnblockerIndexMatch) {
        lastUnblockerIndex = parseInt(lastUnblockerIndexMatch[1], 10);
      }
      const lastUnblockRequestAtMatch = trimmed.match(
        /^-?\s*\*\*Last Unblock Request At:\*\*\s*(.+)$/,
      );
      if (lastUnblockRequestAtMatch) {
        lastUnblockRequestAt = lastUnblockRequestAtMatch[1];
      }
    } else if (currentSection === "description") {
      description = description ? `${description}\n${trimmed}` : trimmed;
    } else if (currentSection === "context") {
      context = context ? `${context}\n${trimmed}` : trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
      }
    } else if (currentSection === "steps") {
      const stepMatch = trimmed.match(/^- \[([x> -])\] \((\w+)\) (.+)$/);
      if (stepMatch) {
        const statusMap: Record<string, MonitorTaskStep["status"]> = {
          x: "done",
          ">": "in_progress",
          " ": "pending",
          "-": "skipped",
        };
        steps.push({
          id: stepMatch[2],
          content: stepMatch[3],
          status: statusMap[stepMatch[1]] || "pending",
          order: steps.length + 1,
        });
      }
    } else if (currentSection === "blocking") {
      // Parse JSON from code block in ## Blocking section
      // Format: ```json\n{...}\n```
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const blockingData = JSON.parse(trimmed);
          if (blockingData.blockedReason) {
            blockedReason = blockingData.blockedReason;
          }
          if (blockingData.unblockedBy) {
            unblockedBy = blockingData.unblockedBy;
          }
          if (blockingData.unblockedAction) {
            unblockedAction = blockingData.unblockedAction;
          }
          if (typeof blockingData.unblockRequestCount === "number") {
            unblockRequestCount = blockingData.unblockRequestCount;
          }
          if (blockingData.escalationState) {
            escalationState = blockingData.escalationState;
          }
          if (typeof blockingData.lastUnblockerIndex === "number") {
            lastUnblockerIndex = blockingData.lastUnblockerIndex;
          }
          if (blockingData.lastUnblockRequestAt) {
            lastUnblockRequestAt = blockingData.lastUnblockRequestAt;
          }
          if (typeof blockingData.unblockRequestFailures === "number") {
            unblockRequestFailures = blockingData.unblockRequestFailures;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    } else if (currentSection === "backlog") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const backlogData = JSON.parse(trimmed);
          if (backlogData.createdBy) {
            createdBy = backlogData.createdBy;
          }
          if (backlogData.assignee) {
            assignee = backlogData.assignee;
          }
          if (backlogData.dependsOn) {
            dependsOn = backlogData.dependsOn;
          }
          if (backlogData.estimatedEffort) {
            estimatedEffort = backlogData.estimatedEffort;
          }
          if (backlogData.startDate) {
            startDate = backlogData.startDate;
          }
          if (backlogData.dueDate) {
            dueDate = backlogData.dueDate;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    } else if (currentSection === "outcome") {
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const outcomeData = JSON.parse(trimmed);
          if (outcomeData.kind) {
            outcome = outcomeData;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }
  }

  return {
    id,
    status,
    priority,
    description: description || "(no description)",
    context,
    source,
    created: created || new Date().toISOString(),
    lastActivity: lastActivity || created || new Date().toISOString(),
    progress,
    blockedReason,
    unblockedBy,
    unblockedAction,
    unblockRequestCount,
    escalationState,
    lastUnblockerIndex,
    lastUnblockRequestAt,
    unblockRequestFailures,
    createdBy,
    assignee,
    dependsOn,
    estimatedEffort,
    startDate,
    dueDate,
    outcome,
    steps: steps.length > 0 ? steps : undefined,
    stepsProgress:
      steps.length > 0
        ? {
            total: steps.length,
            done: steps.filter((s) => s.status === "done").length,
            inProgress: steps.filter((s) => s.status === "in_progress").length,
            pending: steps.filter((s) => s.status === "pending").length,
            skipped: steps.filter((s) => s.status === "skipped").length,
          }
        : undefined,
  };
}

// ============================================================================
// Data Access Functions
// ============================================================================

async function getAgentDirs(): Promise<{ agentId: string; workspaceDir: string }[]> {
  try {
    const entries = await fs.readdir(OPENCLAW_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith(WORKSPACE_PREFIX))
      .map((e) => ({
        agentId: e.name.slice(WORKSPACE_PREFIX.length),
        workspaceDir: path.join(OPENCLAW_DIR, e.name),
      }));
  } catch {
    return [];
  }
}

async function getAgentInfo(agentId: string): Promise<AgentInfo | null> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  try {
    await fs.access(workspaceDir);
  } catch {
    return null;
  }

  let hasCurrentTask = false;
  let taskCount = 0;

  // Check current task
  const currentTaskPath = path.join(workspaceDir, CURRENT_TASK_FILENAME);
  try {
    const content = await fs.readFile(currentTaskPath, "utf-8");
    hasCurrentTask =
      !content.includes("No task in progress") && !content.includes("No active focus");
  } catch {
    // No current task file
  }

  // Count tasks
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  try {
    const files = await fs.readdir(tasksDir);
    taskCount = files.filter((f) => f.startsWith("task_") && f.endsWith(".md")).length;
  } catch {
    // No tasks directory
  }

  return { id: agentId, workspaceDir, hasCurrentTask, taskCount };
}

async function listAgents(): Promise<AgentInfo[]> {
  const agentDirs = await getAgentDirs();
  const agents: AgentInfo[] = [];

  for (const { agentId } of agentDirs) {
    const info = await getAgentInfo(agentId);
    if (info) {
      agents.push(info);
    }
  }

  return agents;
}

async function getCurrentTask(agentId: string): Promise<CurrentTaskInfo> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const currentTaskPath = path.join(workspaceDir, CURRENT_TASK_FILENAME);

  try {
    const content = await fs.readFile(currentTaskPath, "utf-8");
    const hasTask =
      !content.includes("No task in progress") && !content.includes("No active focus");

    // Extract summary from content
    let taskSummary: string | null = null;
    if (hasTask) {
      const taskMatch = content.match(/\*\*Task:\*\*\s*(.+)/);
      const focusMatch = content.match(/\*\*Focus:\*\*\s*(.+)/);
      taskSummary = taskMatch?.[1] || focusMatch?.[1] || null;
    }

    return { agentId, hasTask, content, taskSummary };
  } catch {
    return { agentId, hasTask: false, content: null, taskSummary: null };
  }
}

async function listTasks(agentId: string, statusFilter?: TaskStatus): Promise<TaskFile[]> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  const tasks: TaskFile[] = [];

  let files: string[] = [];
  try {
    files = await fs.readdir(tasksDir);
  } catch {
    return tasks;
  }

  for (const file of files) {
    if (!file.endsWith(".md") || !file.startsWith("task_")) {
      continue;
    }
    try {
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    } catch {
      // File may have been deleted between readdir and readFile
    }
  }

  // Sort by priority then creation time
  const priorityOrder: Record<TaskPriority, number> = { urgent: 0, high: 1, medium: 2, low: 3 };
  tasks.sort((a, b) => {
    const priorityDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    return new Date(b.created).getTime() - new Date(a.created).getTime();
  });

  return tasks;
}

async function getTaskById(agentId: string, taskId: string): Promise<TaskFile | null> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);

  // 1. Check active tasks directory first
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  const taskFilePath = path.join(tasksDir, `${taskId}.md`);
  try {
    const content = await fs.readFile(taskFilePath, "utf-8");
    const task = parseTaskFileMd(content, `${taskId}.md`);
    if (task) {
      return task;
    }
  } catch {
    // Not in active tasks, check history
  }

  // 2. Fallback: search task-history files
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  try {
    const files = await fs.readdir(historyDir);
    const monthFiles = files
      .filter((f: string) => /^\d{4}-\d{2}\.md$/.test(f))
      .toSorted()
      .toReversed();

    for (const monthFile of monthFiles) {
      const historyPath = path.join(historyDir, monthFile);
      const content = await fs.readFile(historyPath, "utf-8");

      // Split into entries and search for matching task ID
      const entries = content.split(/(?=^## \[)/m);
      for (const entry of entries) {
        const taskIdMatch = entry.match(/\*\*Task ID:\*\*\s*(task_[a-z0-9_]+)/);
        if (taskIdMatch && taskIdMatch[1] === taskId) {
          // Parse completed task from history entry
          const statusMatch = entry.match(/\*\*Completed:\*\*\s*(.+)/);
          const priorityMatch = entry.match(/\*\*Priority:\*\*\s*(.+)/);
          const startedMatch = entry.match(/\*\*Started:\*\*\s*(.+)/);
          const titleMatch = entry.match(/^## \[.+?\]\s*(.+)$/m);
          const summaryMatch = entry.match(/### Summary\n([\s\S]*?)(?=\n---|\n## |$)/);

          const progressLines: string[] = [];
          const progressSection = entry.match(/### Progress\n([\s\S]*?)(?=\n### |$)/);
          if (progressSection) {
            const pLines = progressSection[1].split("\n");
            for (const pl of pLines) {
              const trimmed = pl.trim();
              if (trimmed.startsWith("- ")) {
                progressLines.push(trimmed.slice(2));
              }
            }
          }

          return {
            id: taskId,
            status: "completed" as TaskStatus,
            priority: (priorityMatch?.[1]?.trim() || "medium") as TaskPriority,
            description: titleMatch?.[1]?.trim() || "(no description)",
            context: summaryMatch?.[1]?.trim(),
            source: "history",
            created: startedMatch?.[1]?.trim() || "",
            lastActivity: statusMatch?.[1]?.trim() || "",
            progress: progressLines,
          };
        }
      }
    }
  } catch {
    // No history directory
  }

  return null;
}

async function getTaskHistory(
  agentId: string,
  options: { limit?: number; month?: string } = {},
): Promise<{ entries: string; months: string[] }> {
  const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
  const historyDir = path.join(workspaceDir, TASK_HISTORY_DIR);
  const limit = options.limit ?? 50;

  let months: string[] = [];
  try {
    const files = await fs.readdir(historyDir);
    months = files
      .filter((f) => /^\d{4}-\d{2}\.md$/.test(f))
      .map((f) => f.replace(".md", ""))
      .toSorted()
      .toReversed();
  } catch {
    return { entries: "", months: [] };
  }

  if (months.length === 0) {
    return { entries: "", months: [] };
  }

  const targetMonth = options.month || months[0];
  const historyPath = path.join(historyDir, `${targetMonth}.md`);

  try {
    const content = await fs.readFile(historyPath, "utf-8");
    const entries = content.split(/(?=^## \[)/m);
    return { entries: entries.slice(-limit).join(""), months };
  } catch {
    return { entries: "", months };
  }
}

// ============================================================================
// HTTP Request Handlers
// ============================================================================

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.end(JSON.stringify(data, null, 2));
}

function errorResponse(res: http.ServerResponse, message: string, status = 400): void {
  jsonResponse(res, { error: message }, status);
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "POST") {
    errorResponse(res, "Method not allowed", 405);
    return;
  }

  // Routes
  if (pathname === "/api/health") {
    jsonResponse(res, { status: "ok", timestamp: new Date().toISOString() });
    return;
  }

  if (pathname === "/api/agents") {
    const agents = await listAgents();
    jsonResponse(res, { agents, count: agents.length });
    return;
  }

  // Agent-specific routes
  const agentMatch = pathname.match(/^\/api\/agents\/([^/]+)\/(.+)$/);
  if (agentMatch) {
    const agentId = agentMatch[1];
    const action = agentMatch[2];

    const workspaceDir = path.join(OPENCLAW_DIR, `${WORKSPACE_PREFIX}${agentId}`);
    const agentInfo = await getAgentInfo(agentId);
    if (!agentInfo) {
      errorResponse(res, `Agent not found: ${agentId}`, 404);
      return;
    }

    // Single task by ID: /api/agents/:agentId/tasks/:taskId
    const taskIdMatch = action.match(/^tasks\/(.+)$/);
    if (taskIdMatch) {
      const taskId = taskIdMatch[1];
      const task = await getTaskById(agentId, taskId);
      if (task) {
        jsonResponse(res, { agentId, task, source: task.source || "active" });
      } else {
        jsonResponse(res, { agentId, task: null, source: "not_found" });
      }
      return;
    }

    if (action === "tasks") {
      const status = url.searchParams.get("status") as TaskStatus | null;
      const tasks = await listTasks(agentId, status || undefined);
      jsonResponse(res, { agentId, tasks, count: tasks.length });
      return;
    }

    if (action === "current") {
      const current = await getCurrentTask(agentId);
      jsonResponse(res, current);
      return;
    }

    if (action === "history") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      const month = url.searchParams.get("month") || undefined;
      const { entries, months } = await getTaskHistory(agentId, { limit, month });
      jsonResponse(res, {
        agentId,
        history: entries,
        months,
        currentMonth: month || months[0] || null,
        hasHistory: entries.length > 0,
      });
      return;
    }

    if (action === "info") {
      jsonResponse(res, agentInfo);
      return;
    }

    if (action === "blocked") {
      const tasks = await listTasks(agentId, "blocked");
      const blockedDetails = tasks.map((t) => ({
        id: t.id,
        description: t.description,
        blockedReason: t.blockedReason,
        unblockedBy: t.unblockedBy,
        unblockedAction: t.unblockedAction,
        unblockRequestCount: t.unblockRequestCount,
        escalationState: t.escalationState,
        lastUnblockerIndex: t.lastUnblockerIndex,
        lastUnblockRequestAt: t.lastUnblockRequestAt,
        unblockRequestFailures: t.unblockRequestFailures,
        lastActivity: t.lastActivity,
      }));
      jsonResponse(res, { agentId, blockedTasks: blockedDetails, count: blockedDetails.length });
      return;
    }

    if (action === "plans") {
      // Look in both workspace-level and global plans directories
      const workspacePlansDir = path.join(workspaceDir, ".openclaw", "plans");
      const globalPlansDir = path.join(OPENCLAW_DIR, "plans");
      const plans: unknown[] = [];

      // Read from workspace plans
      try {
        const files = await fs.readdir(workspacePlansDir);
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          try {
            const raw = await fs.readFile(path.join(workspacePlansDir, file), "utf-8");
            plans.push(JSON.parse(raw));
          } catch {
            /* skip invalid */
          }
        }
      } catch {
        /* no workspace plans dir */
      }

      // Read from global plans (filter by agentId)
      try {
        const files = await fs.readdir(globalPlansDir);
        for (const file of files) {
          if (!file.endsWith(".json")) {
            continue;
          }
          try {
            const raw = await fs.readFile(path.join(globalPlansDir, file), "utf-8");
            const plan = JSON.parse(raw);
            if (plan.agentId === agentId || file.startsWith(agentId + "_")) {
              plans.push(plan);
            }
          } catch {
            /* skip invalid */
          }
        }
      } catch {
        /* no global plans dir */
      }

      // Sort by updatedAt/createdAt descending
      plans.sort((a: any, b: any) => {
        const ta = new Date(a.updatedAt || a.createdAt || a.submittedAt || 0).getTime();
        const tb = new Date(b.updatedAt || b.createdAt || b.submittedAt || 0).getTime();
        return tb - ta;
      });
      jsonResponse(res, { agentId, plans, count: plans.length });
      return;
    }

    errorResponse(res, `Unknown action: ${action}`, 404);
    return;
  }

  // Team State endpoint
  if (pathname === "/api/team-state") {
    const teamStatePath = path.join(OPENCLAW_DIR, "team-state.json");
    try {
      const raw = await fs.readFile(teamStatePath, "utf-8");
      const state = JSON.parse(raw);
      jsonResponse(res, state);
    } catch {
      jsonResponse(res, { version: 1, agents: {}, lastUpdatedMs: 0 });
    }
    return;
  }

  // Plans endpoint moved into agent action handler above

  // Events endpoint: /api/events?limit=100&since=<ISO>
  if (pathname === "/api/events") {
    const limit = Number(url.searchParams.get("limit")) || 100;
    const since = url.searchParams.get("since");
    const eventLogPath = path.join(OPENCLAW_DIR, "logs", "coordination-events.ndjson");
    try {
      const raw = await fs.readFile(eventLogPath, "utf-8");
      const lines = raw.trim().split("\n").filter(Boolean);
      let events = lines
        .map((line: string) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      if (since) {
        const sinceMs = new Date(since).getTime();
        events = events.filter((e: any) => {
          const ts = e.timestampMs || new Date(e.timestamp || 0).getTime();
          return ts >= sinceMs;
        });
      }
      // Return last N events
      events = events.slice(-limit);
      jsonResponse(res, { events, count: events.length, total: lines.length });
    } catch {
      jsonResponse(res, { events: [], count: 0, total: 0 });
    }
    return;
  }

  // Root endpoint
  if (pathname === "/" || pathname === "/api") {
    jsonResponse(res, {
      name: "Task Monitor API",
      version: "1.2.0",
      endpoints: [
        "GET /api/health",
        "GET /api/agents",
        "GET /api/agents/:agentId/info",
        "GET /api/agents/:agentId/tasks",
        "GET /api/agents/:agentId/tasks/:taskId",
        "GET /api/agents/:agentId/tasks?status=in_progress",
        "GET /api/agents/:agentId/current",
        "GET /api/agents/:agentId/blocked",
        "GET /api/agents/:agentId/history",
        "GET /api/agents/:agentId/history?month=2026-02",
        "GET /api/agents/:agentId/plans",
        "GET /api/team-state",
        "GET /api/events?limit=100&since=<ISO>",
        "POST /api/workspace-file",
        "WS /ws",
      ],
      docs: "https://github.com/pronto-lab/prontolab-openclaw/blob/main/PRONTOLAB.md",
    });
    return;
  }

  // POST /api/workspace-file — Write a file to a workspace directory
  if (pathname === "/api/workspace-file" && req.method === "POST") {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const bodyStr = Buffer.concat(chunks).toString("utf-8");
    let body: { path?: string; content?: string };
    try {
      body = JSON.parse(bodyStr);
    } catch {
      errorResponse(res, "Invalid JSON body", 400);
      return;
    }
    if (!body.path || typeof body.content !== "string") {
      errorResponse(res, "path and content are required", 400);
      return;
    }
    const safePath = body.path.replace(/\.\./g, "");
    const targetPath = path.join(OPENCLAW_DIR, safePath);
    if (!targetPath.startsWith(OPENCLAW_DIR)) {
      errorResponse(res, "Path traversal not allowed", 403);
      return;
    }
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, body.content, "utf-8");
      console.log(`[workspace-file] Wrote ${safePath} (${body.content.length} bytes)`);
      jsonResponse(res, { ok: true, path: safePath, bytes: body.content.length });
    } catch (err) {
      console.error(`[workspace-file] Write failed:`, err);
      errorResponse(res, "Failed to write file", 500);
    }
    return;
  }

  errorResponse(res, "Not found", 404);
}

// ============================================================================
// WebSocket & File Watching
// ============================================================================

function setupWebSocket(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: "/ws" });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[ws] Client connected (${clients.size} total)`);

    // Send welcome message
    const welcome: WsMessage = {
      type: "connected",
      timestamp: new Date().toISOString(),
      data: { message: "Connected to Task Monitor" },
    };
    ws.send(JSON.stringify(welcome));

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[ws] Client disconnected (${clients.size} remaining)`);
    });

    ws.on("error", (err) => {
      console.error("[ws] Client error:", err.message);
      clients.delete(ws);
    });
  });

  // Broadcast to all clients
  function broadcast(message: WsMessage): void {
    const json = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        try {
          client.send(json);
        } catch {
          clients.delete(client);
        }
      }
    }
  }

  // Setup file watcher
  // NOTE: chokidar glob patterns (workspace-*/tasks/*.md) don't expand correctly
  // in Bun. Use explicit directory paths instead.
  const entriesSync = fsSync.readdirSync(OPENCLAW_DIR, { withFileTypes: true });
  const workspaceDirs = entriesSync
    .filter((e) => e.isDirectory() && e.name.startsWith(WORKSPACE_PREFIX))
    .map((e) => e.name);

  const watchPaths: string[] = [
    // Global files
    path.join(OPENCLAW_DIR, "team-state.json"),
    path.join(OPENCLAW_DIR, "logs", "coordination-events.ndjson"),
    path.join(OPENCLAW_DIR, "plans"),
  ];

  // Add per-workspace task directories and CURRENT_TASK files
  for (const dir of workspaceDirs) {
    watchPaths.push(path.join(OPENCLAW_DIR, dir, TASKS_DIR));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, CURRENT_TASK_FILENAME));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, "MILESTONES.md"));
    watchPaths.push(path.join(OPENCLAW_DIR, dir, ".openclaw", "plans"));
  }

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("all", (event, filePath) => {
    const relativePath = path.relative(OPENCLAW_DIR, filePath);
    const basename = path.basename(filePath);

    // Handle global (non-workspace) files first
    const isTeamState = basename === "team-state.json";
    const isEventLog = basename === "coordination-events.ndjson";
    const isGlobalPlan = relativePath.startsWith("plans/") && basename.endsWith(".json");

    if (isTeamState || isEventLog || isGlobalPlan) {
      let msgType: WsMessage["type"] = "team_state_update";
      if (isEventLog) {
        msgType = "event_log";
      } else if (isGlobalPlan) {
        msgType = "plan_update";
      }

      const message: WsMessage = {
        type: msgType,
        agentId: isGlobalPlan ? basename.split("_")[0] : undefined,
        timestamp: new Date().toISOString(),
        data: { event, file: basename },
      };

      console.log(`[watch] ${event}: (global)/${basename}`);
      broadcast(message);
      return;
    }

    // Extract agent ID from workspace path (format: workspace-{agentId}/...)
    const parts = relativePath.split(path.sep);
    const workspaceDir = parts[0];

    if (!workspaceDir || !workspaceDir.startsWith(WORKSPACE_PREFIX)) {
      return;
    }

    const agentId = workspaceDir.slice(WORKSPACE_PREFIX.length);

    // Determine update type for workspace files
    const isCurrentTask = filePath.includes(CURRENT_TASK_FILENAME);
    const isPlan = filePath.includes("/plans/") && filePath.endsWith(".json");
    const taskMatch = filePath.match(/task_([a-z0-9_]+)\.md$/);

    let msgType: WsMessage["type"] = "task_update";
    if (isCurrentTask) {
      msgType = "agent_update";
    } else if (isPlan) {
      msgType = "plan_update";
    }

    const message: WsMessage = {
      type: msgType,
      agentId,
      taskId: taskMatch ? `task_${taskMatch[1]}` : undefined,
      timestamp: new Date().toISOString(),
      data: { event, file: basename },
    };

    console.log(`[watch] ${event}: ${agentId}/${basename}`);
    broadcast(message);
  });

  watcher.on("error", (err) => {
    console.error("[watch] Error:", err.message);
  });

  console.log("[watch] Watching for task changes...");

  return wss;
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const { port, host } = parseArgs();

  // Create HTTP server
  const server = http.createServer((req, res) => {
    // Skip WebSocket upgrade requests
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    handleRequest(req, res).catch((err) => {
      console.error("[http] Request error:", err);
      errorResponse(res, "Internal server error", 500);
    });
  });

  // Setup WebSocket
  setupWebSocket(server);

  // Start server
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    server.listen(port, host);
  });

  const addr = server.address();
  const boundPort = typeof addr === "object" && addr ? addr.port : port;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║           🦞 Task Monitor API Server                         ║
╚══════════════════════════════════════════════════════════════╝

  HTTP:  http://${host}:${boundPort}
  WS:    ws://${host}:${boundPort}/ws

  Endpoints:
    GET /api/agents              - List all agents
    GET /api/agents/:id/tasks    - Get agent tasks
    GET /api/agents/:id/current  - Get current task
    GET /api/agents/:id/blocked  - Get blocked tasks
    GET /api/agents/:id/history  - Get task history

  Press Ctrl+C to stop
`);

  // Graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[shutdown] Stopping server...");
    server.close(() => {
      console.log("[shutdown] Server stopped");
      process.exit(0);
    });
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
