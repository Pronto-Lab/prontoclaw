import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  readTeamState,
  updateAgentEntry,
  removeAgentEntry,
  findLeadAgent,
  findActiveWorkers,
  findInterruptedAgents,
} from "./team-state.js";

describe("team state", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "team-state-test-"));
    fs.mkdirSync(path.join(tmpDir, "tasks"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  it("returns empty state when no file exists", async () => {
    const state = await readTeamState(tmpDir);
    expect(state.version).toBe(1);
    expect(Object.keys(state.agents)).toHaveLength(0);
  });

  it("adds and updates agent entries", async () => {
    await updateAgentEntry(tmpDir, "main", {
      role: "lead",
      currentTaskId: "task_abc",
      status: "active",
    });

    const state = await readTeamState(tmpDir);
    expect(state.agents["main"]).toBeDefined();
    expect(state.agents["main"].role).toBe("lead");
    expect(state.agents["main"].currentTaskId).toBe("task_abc");
    expect(state.agents["main"].status).toBe("active");
  });

  it("preserves existing fields on partial update", async () => {
    await updateAgentEntry(tmpDir, "worker1", {
      role: "worker",
      currentTaskId: "task_1",
      status: "active",
    });

    await updateAgentEntry(tmpDir, "worker1", {
      status: "interrupted",
      lastFailureReason: "timeout",
    });

    const state = await readTeamState(tmpDir);
    expect(state.agents["worker1"].role).toBe("worker");
    expect(state.agents["worker1"].currentTaskId).toBe("task_1");
    expect(state.agents["worker1"].status).toBe("interrupted");
    expect(state.agents["worker1"].lastFailureReason).toBe("timeout");
  });

  it("removes agent entries", async () => {
    await updateAgentEntry(tmpDir, "main", { role: "lead", status: "active" });
    await updateAgentEntry(tmpDir, "worker1", { role: "worker", status: "active" });

    await removeAgentEntry(tmpDir, "worker1");

    const state = await readTeamState(tmpDir);
    expect(state.agents["main"]).toBeDefined();
    expect(state.agents["worker1"]).toBeUndefined();
  });

  it("findLeadAgent returns lead", async () => {
    await updateAgentEntry(tmpDir, "main", { role: "lead", status: "active" });
    await updateAgentEntry(tmpDir, "w1", { role: "worker", status: "active" });

    const state = await readTeamState(tmpDir);
    const lead = findLeadAgent(state);
    expect(lead?.agentId).toBe("main");
  });

  it("findActiveWorkers returns non-lead active agents", async () => {
    const freshState = await readTeamState(tmpDir);
    expect(Object.keys(freshState.agents)).toHaveLength(0);

    await updateAgentEntry(tmpDir, "lead1", { role: "lead", status: "active" });
    await updateAgentEntry(tmpDir, "active1", { role: "worker", status: "active" });
    await updateAgentEntry(tmpDir, "idle1", { role: "worker", status: "idle" });

    const state = await readTeamState(tmpDir);
    const workers = findActiveWorkers(state);

    expect(state.agents["lead1"].role).toBe("lead");
    expect(state.agents["active1"].status).toBe("active");
    expect(state.agents["idle1"].status).toBe("idle");

    const workerIds = workers.map((w) => w.agentId).toSorted();
    expect(workerIds).toEqual(["active1"]);
  });

  it("findInterruptedAgents returns interrupted agents", async () => {
    await updateAgentEntry(tmpDir, "main", { role: "lead", status: "active" });
    await updateAgentEntry(tmpDir, "w1", { role: "worker", status: "interrupted" });
    await updateAgentEntry(tmpDir, "w2", { role: "worker", status: "active" });

    const state = await readTeamState(tmpDir);
    const interrupted = findInterruptedAgents(state);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0].agentId).toBe("w1");
  });
});
