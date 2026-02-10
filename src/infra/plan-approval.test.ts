import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { submitPlan, getPlan, approvePlan, rejectPlan, listPendingPlans } from "./plan-approval.js";

describe("plan-approval", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("submits and reads a plan", async () => {
    const plan = await submitPlan(tmpDir, {
      agentId: "worker-1",
      taskId: "task_abc",
      title: "Implement auth",
      steps: ["Step 1: add login endpoint", "Step 2: add JWT validation"],
      toolsRequested: ["exec", "write"],
    });

    expect(plan.id).toMatch(/^plan_/);
    expect(plan.status).toBe("pending");
    expect(plan.agentId).toBe("worker-1");

    const read = await getPlan(tmpDir, plan.id);
    expect(read).not.toBeNull();
    expect(read!.title).toBe("Implement auth");
    expect(read!.steps).toHaveLength(2);
  });

  it("approves a pending plan", async () => {
    const plan = await submitPlan(tmpDir, {
      agentId: "w",
      taskId: "t1",
      title: "Test plan",
      steps: ["a"],
    });

    const approved = await approvePlan(tmpDir, plan.id, "lead-1");
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
    expect(approved!.decidedBy).toBe("lead-1");
    expect(approved!.decidedAt).toBeTruthy();
  });

  it("rejects a pending plan", async () => {
    const plan = await submitPlan(tmpDir, {
      agentId: "w",
      taskId: "t1",
      title: "Bad plan",
      steps: ["a"],
    });

    const rejected = await rejectPlan(tmpDir, plan.id, "Too risky", "lead-1");
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe("rejected");
    expect(rejected!.rejectReason).toBe("Too risky");
  });

  it("cannot approve an already approved plan", async () => {
    const plan = await submitPlan(tmpDir, {
      agentId: "w",
      taskId: "t1",
      title: "Done",
      steps: [],
    });
    await approvePlan(tmpDir, plan.id);
    const second = await approvePlan(tmpDir, plan.id);
    expect(second).toBeNull();
  });

  it("cannot reject an already rejected plan", async () => {
    const plan = await submitPlan(tmpDir, {
      agentId: "w",
      taskId: "t1",
      title: "Done",
      steps: [],
    });
    await rejectPlan(tmpDir, plan.id, "no");
    const second = await rejectPlan(tmpDir, plan.id, "still no");
    expect(second).toBeNull();
  });

  it("lists only pending plans", async () => {
    const p1 = await submitPlan(tmpDir, { agentId: "w", taskId: "t1", title: "A", steps: [] });
    const p2 = await submitPlan(tmpDir, { agentId: "w", taskId: "t2", title: "B", steps: [] });
    await approvePlan(tmpDir, p1.id);

    const pending = await listPendingPlans(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(p2.id);
  });

  it("returns null for unknown plan", async () => {
    const result = await getPlan(tmpDir, "plan_nonexistent");
    expect(result).toBeNull();
  });
});
