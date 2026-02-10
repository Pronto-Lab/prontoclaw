import fs from "node:fs/promises";
import path from "node:path";
import { atomicReadModifyWrite, atomicRead } from "./atomic-storage.js";

export type AgentRole = "lead" | "worker" | "specialist";

export type AgentTeamEntry = {
  agentId: string;
  role: AgentRole;
  currentTaskId: string | null;
  lastHeartbeatMs: number;
  status: "active" | "idle" | "interrupted";
  consecutiveFailures: number;
  lastFailureReason?: string;
  backoffUntilMs?: number;
};

export type TeamStateData = {
  version: number;
  agents: Record<string, AgentTeamEntry>;
  lastUpdatedMs: number;
};

/** Returns a fresh deep-cloned default state to avoid shared-reference mutation. */
function freshDefaultState(): TeamStateData {
  return { version: 1, agents: {}, lastUpdatedMs: 0 };
}

function resolveTeamStatePath(stateDir: string): string {
  return path.join(stateDir, "team-state.json");
}

export async function ensureTeamStateDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
}

export async function readTeamState(stateDir: string): Promise<TeamStateData> {
  return atomicRead(resolveTeamStatePath(stateDir), freshDefaultState());
}

export async function updateAgentEntry(
  stateDir: string,
  agentId: string,
  update: Partial<AgentTeamEntry>,
): Promise<TeamStateData> {
  await ensureTeamStateDir(stateDir);
  const filePath = resolveTeamStatePath(stateDir);
  const lockDir = stateDir;

  return atomicReadModifyWrite(filePath, lockDir, "team_state", freshDefaultState(), (state) => {
    const existing = state.agents[agentId] ?? {
      agentId,
      role: "worker" as AgentRole,
      currentTaskId: null,
      lastHeartbeatMs: Date.now(),
      status: "idle" as const,
      consecutiveFailures: 0,
    };

    state.agents[agentId] = { ...existing, ...update, agentId };
    state.lastUpdatedMs = Date.now();
    return state;
  });
}

export async function removeAgentEntry(stateDir: string, agentId: string): Promise<TeamStateData> {
  await ensureTeamStateDir(stateDir);
  const filePath = resolveTeamStatePath(stateDir);
  const lockDir = stateDir;

  return atomicReadModifyWrite(filePath, lockDir, "team_state", freshDefaultState(), (state) => {
    delete state.agents[agentId];
    state.lastUpdatedMs = Date.now();
    return state;
  });
}

export function findLeadAgent(state: TeamStateData): AgentTeamEntry | undefined {
  return Object.values(state.agents).find((a) => a.role === "lead");
}

export function findActiveWorkers(state: TeamStateData): AgentTeamEntry[] {
  return Object.values(state.agents).filter((a) => a.status === "active" && a.role !== "lead");
}

export function findInterruptedAgents(state: TeamStateData): AgentTeamEntry[] {
  return Object.values(state.agents).filter((a) => a.status === "interrupted");
}
