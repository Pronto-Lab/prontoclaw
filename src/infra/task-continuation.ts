import fs from "node:fs/promises";
import path from "node:path";
import type { CliDeps } from "../cli/deps.js";
import type { loadConfig } from "../config/config.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { agentCommand } from "../commands/agent.js";
import { resolveStateDir } from "../config/paths.js";
import { logVerbose } from "../globals.js";
import { resolveAgentBoundAccountId } from "../routing/bindings.js";
import { buildAgentMainSessionKey } from "../routing/session-key.js";
import { defaultRuntime } from "../runtime.js";

const _CURRENT_TASK_FILENAME = "CURRENT_TASK.md";
const RESUME_TRACKER_FILENAME = "task-continuation-last.json";
const RESUME_COOLDOWN_MS = 5 * 60 * 1000;

export interface PendingTask {
  agentId: string;
  task: string;
  threadId?: string;
  context: string;
  next: string;
  progress: string[];
}

interface ResumeTracker {
  version: number;
  lastResumeAt: number;
}

function getResumeTrackerPath(): string {
  return path.join(resolveStateDir(), RESUME_TRACKER_FILENAME);
}

async function loadResumeTracker(): Promise<ResumeTracker | null> {
  try {
    const raw = await fs.readFile(getResumeTrackerPath(), "utf-8");
    const parsed = JSON.parse(raw) as ResumeTracker;
    if (parsed.version === 1 && typeof parsed.lastResumeAt === "number") {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveResumeTracker(): Promise<void> {
  const tracker: ResumeTracker = { version: 1, lastResumeAt: Date.now() };
  const filePath = getResumeTrackerPath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(tracker, null, 2), "utf-8");
}

function _parseCurrentTaskMd(content: string): PendingTask | null {
  const currentMatch = content.match(/##\s*Current\s*\n([\s\S]*?)(?=\n---|\n##|$)/i);
  if (!currentMatch) {
    return null;
  }

  const section = currentMatch[1].trim();
  if (
    !section ||
    section.includes("*(진행 중인 작업 없음)*") ||
    section.includes("*(No task in progress)*")
  ) {
    return null;
  }

  const taskMatch = section.match(/\*\*Task:\*\*\s*(.+)/i);
  const threadIdMatch = section.match(/\*\*Thread ID:\*\*\s*(\d+)/i);
  const contextMatch = section.match(/\*\*Context:\*\*\s*(.+)/i);
  const nextMatch = section.match(/\*\*Next:\*\*\s*(.+)/i);

  const progressMatch = section.match(/\*\*Progress:\*\*\s*([\s\S]*?)(?=\*\*|$)/i);
  const progressItems: string[] = [];
  if (progressMatch) {
    const lines = progressMatch[1].split("\n");
    for (const line of lines) {
      const itemMatch = line.match(/^\s*-\s*\[.\]\s*(.+)/);
      if (itemMatch) {
        progressItems.push(itemMatch[1].trim());
      }
    }
  }

  const task = taskMatch?.[1]?.trim();
  if (!task) {
    return null;
  }

  return {
    agentId: "",
    task,
    threadId: threadIdMatch?.[1]?.trim(),
    context: contextMatch?.[1]?.trim() ?? "",
    next: nextMatch?.[1]?.trim() ?? "",
    progress: progressItems,
  };
}

export async function loadPendingTasks(cfg: ReturnType<typeof loadConfig>): Promise<PendingTask[]> {
  const agentIds = listAgentIds(cfg);
  const tasks: PendingTask[] = [];

  for (const agentId of agentIds) {
    try {
      const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
      const tasksDir = path.join(workspaceDir, "tasks");

      let files: string[] = [];
      try {
        files = await fs.readdir(tasksDir);
      } catch {
        continue;
      }

      for (const file of files) {
        if (!file.endsWith(".md") || !file.startsWith("task_")) {
          continue;
        }
        try {
          const content = await fs.readFile(path.join(tasksDir, file), "utf-8");
          const metaBlock = content.split("## ").find((s) => s.startsWith("Metadata")) || "";
          const statusMatch = metaBlock.match(/\*\*Status:\*\*\s*(\S+)/);
          const status = statusMatch?.[1];
          if (status !== "in_progress" && status !== "blocked") {
            continue;
          }

          // Current task format writes description/context as dedicated sections.
          // Keep legacy metadata key fallback for older task files.
          const descSectionMatch = content.match(/##\s*Description\s*\n([\s\S]*?)(?=\n## |$)/i);
          const descriptionFromSection = descSectionMatch?.[1]?.trim();
          const descLegacyMatch = content.match(/\*\*Description:\*\*\s*(.+)/i);
          const description =
            descriptionFromSection || descLegacyMatch?.[1]?.trim() || file.replace(".md", "");

          const progressItems: string[] = [];
          const progressSection = content.match(/## Progress\n([\s\S]*?)(?=\n## |$)/);
          if (progressSection) {
            for (const line of progressSection[1].split("\n")) {
              const item = line.match(/^\s*-\s+(.+)/);
              if (item) {
                progressItems.push(item[1].trim());
              }
            }
          }

          const contextSectionMatch = content.match(/##\s*Context\s*\n([\s\S]*?)(?=\n## |$)/i);
          const contextFromSection = contextSectionMatch?.[1]?.trim();
          const contextLegacyMatch = content.match(/\*\*Context:\*\*\s*(.+)/i);
          const context = contextFromSection || contextLegacyMatch?.[1]?.trim() || "";

          tasks.push({
            agentId,
            task: description,
            context,
            next: "",
            progress: progressItems,
          });
        } catch {
          continue;
        }
      }
    } catch {
      continue;
    }
  }

  return tasks;
}

function formatResumeMessage(task: PendingTask): string {
  const lines = ["🔄 Gateway가 재시작됐어. 하던 일 이어서 해줘:", "", `**Task:** ${task.task}`];

  if (task.next) {
    lines.push(`**Next:** ${task.next}`);
  }

  if (task.context) {
    lines.push(`**Context:** ${task.context}`);
  }

  if (task.progress.length > 0) {
    lines.push("**Progress:**");
    for (const item of task.progress) {
      lines.push(`- ${item}`);
    }
  }

  lines.push("", "CURRENT_TASK.md 파일 확인하고 작업 이어서 진행해줘.");

  return lines.join("\n");
}

export async function resumePendingTasks(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
}): Promise<{ resumed: number; skipped: number }> {
  const tracker = await loadResumeTracker();
  const now = Date.now();

  if (tracker && now - tracker.lastResumeAt < RESUME_COOLDOWN_MS) {
    const remainingSec = Math.ceil((RESUME_COOLDOWN_MS - (now - tracker.lastResumeAt)) / 1000);
    logVerbose(`task-continuation: skipping (cooldown ${remainingSec}s remaining)`);
    return { resumed: 0, skipped: 0 };
  }

  const tasks = await loadPendingTasks(params.cfg);
  if (tasks.length === 0) {
    logVerbose("task-continuation: no pending tasks found");
    return { resumed: 0, skipped: 0 };
  }

  logVerbose(`task-continuation: found ${tasks.length} pending task(s)`);

  let resumed = 0;
  let skipped = 0;

  for (const task of tasks) {
    try {
      const message = formatResumeMessage(task);
      const sessionKey = buildAgentMainSessionKey({ agentId: task.agentId });
      const accountId = resolveAgentBoundAccountId(
        params.cfg,
        task.agentId,
        params.cfg.agents?.defaults?.taskContinuation?.channel ?? "discord",
      );

      await agentCommand(
        {
          message,
          agentId: task.agentId,
          accountId,
          sessionKey,
          deliver: false,
          bestEffortDeliver: false,
        },
        defaultRuntime,
        params.deps,
      );

      logVerbose(`task-continuation: resumed task for agent ${task.agentId}`);
      resumed++;
    } catch (err) {
      logVerbose(`task-continuation: failed to resume for ${task.agentId}: ${String(err)}`);
      skipped++;
    }
  }

  if (resumed > 0) {
    await saveResumeTracker();
  }

  return { resumed, skipped };
}

export function scheduleTaskContinuation(params: {
  cfg: ReturnType<typeof loadConfig>;
  deps: CliDeps;
  delayMs?: number;
}): void {
  const delay = params.delayMs ?? 1000;

  setTimeout(() => {
    void resumePendingTasks({
      cfg: params.cfg,
      deps: params.deps,
    }).catch((err) => {
      logVerbose(`task-continuation: scheduler error: ${String(err)}`);
    });
  }, delay);
}
