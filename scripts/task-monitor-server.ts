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
 *   GET /api/health                    - Health check
 *
 * WebSocket:
 *   ws://host:port/ws                  - Real-time task change notifications
 */

import chokidar from "chokidar";
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

type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
type TaskPriority = "low" | "medium" | "high" | "urgent";

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
  type: "agent_update" | "task_update" | "connected";
  agentId?: string;
  taskId?: string;
  timestamp: string;
  data?: unknown;
}

// ============================================================================
// Paths
// ============================================================================

const AGENTS_DIR = path.join(os.homedir(), ".openclaw", "agents");
const TASKS_DIR = "tasks";
const CURRENT_TASK_FILENAME = "CURRENT_TASK.md";
const TASK_HISTORY_FILENAME = "TASK_HISTORY.md";

const _KNOWN_AGENTS = [
  "main",
  "eden",
  "seum",
  "yunseul",
  "miri",
  "onsae",
  "ieum",
  "dajim",
  "hangyeol",
  "nuri",
  "test",
  "ruda",
];

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
    } else if (currentSection === "description") {
      description = trimmed;
    } else if (currentSection === "context") {
      context = trimmed;
    } else if (currentSection === "last activity") {
      lastActivity = trimmed;
    } else if (currentSection === "progress") {
      if (trimmed.startsWith("- ")) {
        progress.push(trimmed.slice(2));
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
  };
}

// ============================================================================
// Data Access Functions
// ============================================================================

async function getAgentDirs(): Promise<string[]> {
  try {
    const entries = await fs.readdir(AGENTS_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

async function getAgentInfo(agentId: string): Promise<AgentInfo | null> {
  const workspaceDir = path.join(AGENTS_DIR, agentId);
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

  for (const agentId of agentDirs) {
    const info = await getAgentInfo(agentId);
    if (info) {
      agents.push(info);
    }
  }

  return agents;
}

async function getCurrentTask(agentId: string): Promise<CurrentTaskInfo> {
  const workspaceDir = path.join(AGENTS_DIR, agentId);
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
  const workspaceDir = path.join(AGENTS_DIR, agentId);
  const tasksDir = path.join(workspaceDir, TASKS_DIR);
  const tasks: TaskFile[] = [];

  try {
    const files = await fs.readdir(tasksDir);
    for (const file of files) {
      if (!file.endsWith(".md") || !file.startsWith("task_")) {
        continue;
      }
      const filePath = path.join(tasksDir, file);
      const content = await fs.readFile(filePath, "utf-8");
      const task = parseTaskFileMd(content, file);
      if (task) {
        if (!statusFilter || task.status === statusFilter) {
          tasks.push(task);
        }
      }
    }
  } catch {
    // Directory doesn't exist
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

async function getTaskHistory(agentId: string, limit = 50): Promise<string> {
  const workspaceDir = path.join(AGENTS_DIR, agentId);
  const historyPath = path.join(workspaceDir, TASK_HISTORY_FILENAME);

  try {
    const content = await fs.readFile(historyPath, "utf-8");
    // Return last N entries (split by ## headers)
    const entries = content.split(/(?=^## \[)/m);
    return entries.slice(-limit).join("");
  } catch {
    return "";
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
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "GET") {
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

    const agentInfo = await getAgentInfo(agentId);
    if (!agentInfo) {
      errorResponse(res, `Agent not found: ${agentId}`, 404);
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
      const history = await getTaskHistory(agentId, limit);
      jsonResponse(res, { agentId, history, hasHistory: history.length > 0 });
      return;
    }

    if (action === "info") {
      jsonResponse(res, agentInfo);
      return;
    }

    errorResponse(res, `Unknown action: ${action}`, 404);
    return;
  }

  // Root endpoint
  if (pathname === "/" || pathname === "/api") {
    jsonResponse(res, {
      name: "Task Monitor API",
      version: "1.0.0",
      endpoints: [
        "GET /api/health",
        "GET /api/agents",
        "GET /api/agents/:agentId/info",
        "GET /api/agents/:agentId/tasks",
        "GET /api/agents/:agentId/tasks?status=in_progress",
        "GET /api/agents/:agentId/current",
        "GET /api/agents/:agentId/history",
        "WS /ws",
      ],
      docs: "https://github.com/pronto-lab/prontolab-openclaw/blob/main/PRONTOLAB.md",
    });
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
        client.send(json);
      }
    }
  }

  // Setup file watcher
  const watchPaths = [
    path.join(AGENTS_DIR, "*", CURRENT_TASK_FILENAME),
    path.join(AGENTS_DIR, "*", TASKS_DIR, "*.md"),
  ];

  const watcher = chokidar.watch(watchPaths, {
    ignoreInitial: true,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });

  watcher.on("all", (event, filePath) => {
    // Extract agent ID from path
    const relativePath = path.relative(AGENTS_DIR, filePath);
    const parts = relativePath.split(path.sep);
    const agentId = parts[0];

    if (!agentId) {
      return;
    }

    // Determine update type
    const isCurrentTask = filePath.includes(CURRENT_TASK_FILENAME);
    const taskMatch = filePath.match(/task_([a-z0-9_]+)\.md$/);

    const message: WsMessage = {
      type: isCurrentTask ? "agent_update" : "task_update",
      agentId,
      taskId: taskMatch ? `task_${taskMatch[1]}` : undefined,
      timestamp: new Date().toISOString(),
      data: { event, file: path.basename(filePath) },
    };

    console.log(`[watch] ${event}: ${agentId}/${path.basename(filePath)}`);
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
