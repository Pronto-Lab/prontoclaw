/**
 * Task-Delegation persistence helpers.
 *
 * Provides atomic read-modify-write operations for delegation data
 * inside Task files. Uses the existing task lock mechanism for safety.
 *
 * @see 11-subagent-task-lifecycle.md (Phase 2)
 */

import { acquireTaskLock } from "../../infra/task-lock.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { computeDelegationSummary, findDelegationByRunId } from "./task-delegation-manager.js";
import type { DelegationEvent, TaskDelegation } from "./task-delegation-types.js";
import { readTask, writeTask, type TaskFile } from "./task-file-io.js";

const log = createSubsystemLogger("task-delegation-persistence");

// ---------------------------------------------------------------------------
// Append a new delegation to a task
// ---------------------------------------------------------------------------

/**
 * Append a new delegation record and its creation event to a task file.
 * Acquires a lock on the task file before writing.
 *
 * @returns true if written, false if task not found or lock failed.
 */
export async function appendDelegationToTask(
  workspaceDir: string,
  taskId: string,
  delegation: TaskDelegation,
  event: DelegationEvent,
): Promise<boolean> {
  let lock: Awaited<ReturnType<typeof acquireTaskLock>> = null;
  try {
    lock = await acquireTaskLock(workspaceDir, taskId);
    const task = await readTask(workspaceDir, taskId);
    if (!task) {
      log.warn?.(`appendDelegationToTask: task not found: ${taskId}`);
      return false;
    }

    const delegations = [...(task.delegations ?? []), delegation];
    const events = [...(task.delegationEvents ?? []), event];
    const summary = computeDelegationSummary(delegations);

    task.delegations = delegations;
    task.delegationEvents = events;
    task.delegationSummary = summary;
    task.lastActivity = new Date().toISOString();

    await writeTask(workspaceDir, task);
    log.info?.(`Delegation ${delegation.delegationId} appended to task ${taskId}`);
    return true;
  } catch (err) {
    log.error?.(`appendDelegationToTask failed for ${taskId}: ${String(err)}`);
    return false;
  } finally {
    lock?.release?.();
  }
}

// ---------------------------------------------------------------------------
// Update an existing delegation in a task
// ---------------------------------------------------------------------------

/**
 * Update an existing delegation record and append an event to the task file.
 * Acquires a lock on the task file before writing.
 *
 * @returns true if updated, false if task/delegation not found or lock failed.
 */
export async function updateDelegationInTask(
  workspaceDir: string,
  taskId: string,
  updatedDelegation: TaskDelegation,
  event: DelegationEvent,
): Promise<boolean> {
  let lock: Awaited<ReturnType<typeof acquireTaskLock>> = null;
  try {
    lock = await acquireTaskLock(workspaceDir, taskId);
    const task = await readTask(workspaceDir, taskId);
    if (!task) {
      log.warn?.(`updateDelegationInTask: task not found: ${taskId}`);
      return false;
    }

    const delegations = task.delegations ?? [];
    const idx = delegations.findIndex(
      (d) => d.delegationId === updatedDelegation.delegationId,
    );
    if (idx === -1) {
      log.warn?.(
        `updateDelegationInTask: delegation ${updatedDelegation.delegationId} not found in task ${taskId}`,
      );
      return false;
    }

    delegations[idx] = updatedDelegation;
    const events = [...(task.delegationEvents ?? []), event];
    const summary = computeDelegationSummary(delegations);

    task.delegations = delegations;
    task.delegationEvents = events;
    task.delegationSummary = summary;
    task.lastActivity = new Date().toISOString();

    await writeTask(workspaceDir, task);
    log.info?.(
      `Delegation ${updatedDelegation.delegationId} updated to ${updatedDelegation.status} in task ${taskId}`,
    );
    return true;
  } catch (err) {
    log.error?.(`updateDelegationInTask failed for ${taskId}: ${String(err)}`);
    return false;
  } finally {
    lock?.release?.();
  }
}

// ---------------------------------------------------------------------------
// Read delegation by runId
// ---------------------------------------------------------------------------

/**
 * Read a specific delegation from a task file by its runId.
 * Does NOT acquire a lock (read-only).
 */
export async function readDelegationByRunId(
  workspaceDir: string,
  taskId: string,
  runId: string,
): Promise<TaskDelegation | undefined> {
  const task = await readTask(workspaceDir, taskId);
  if (!task?.delegations) {
    return undefined;
  }
  return findDelegationByRunId(task.delegations, runId);
}

// ---------------------------------------------------------------------------
// Read all delegations for a task
// ---------------------------------------------------------------------------

/**
 * Read all delegation records for a task.
 * Does NOT acquire a lock (read-only).
 */
export async function readTaskDelegations(
  workspaceDir: string,
  taskId: string,
): Promise<{ task: TaskFile; delegations: TaskDelegation[] } | undefined> {
  const task = await readTask(workspaceDir, taskId);
  if (!task) {
    return undefined;
  }
  return { task, delegations: task.delegations ?? [] };
}
