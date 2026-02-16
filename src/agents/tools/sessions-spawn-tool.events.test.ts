import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockCallGateway = vi.fn();
vi.mock('../../gateway/call.js', () => ({
  callGateway: (...args: unknown[]) => mockCallGateway(...args),
}));

const mockEmit = vi.fn();
vi.mock('../../infra/events/bus.js', () => ({
  emit: (...args: unknown[]) => mockEmit(...args),
}));

vi.mock('../../config/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config/config.js')>();
  return {
    ...actual,
    loadConfig: () => ({
      session: { mainKey: 'main', scope: 'per-sender' },
    }),
  };
});

vi.mock('../agent-scope.js', () => ({
  resolveAgentConfig: vi.fn(() => ({
    subagents: {
      allowAgents: ['*'],
    },
  })),
}));

vi.mock('../lanes.js', () => ({
  AGENT_LANE_SUBAGENT: 'subagent',
}));

vi.mock('../subagent-announce.js', () => ({
  buildSubagentSystemPrompt: vi.fn(() => 'subagent-system-prompt'),
}));

const mockRegisterSubagentRun = vi.fn();
vi.mock('../subagent-registry.js', () => ({
  registerSubagentRun: (...args: unknown[]) => mockRegisterSubagentRun(...args),
}));

import { createSessionsSpawnTool } from './sessions-spawn-tool.js';

describe('sessions_spawn collaboration events', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits spawn + send + spawn_result(accepted) with shared conversationId', async () => {
    mockCallGateway.mockResolvedValueOnce({ runId: 'run-123' });

    const tool = createSessionsSpawnTool({
      agentSessionKey: 'agent:planner:main',
    });

    const result = await tool.execute('call-1', {
      task: 'Review this implementation',
      agentId: 'worker-deep',
      cleanup: 'keep',
    });

    expect((result as { details?: { status?: string } }).details?.status).toBe('accepted');
    expect(mockCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'agent',
        params: expect.objectContaining({
          lane: 'subagent',
          message: 'Review this implementation',
        }),
      }),
    );

    const events = mockEmit.mock.calls.map((call: unknown[]) => call[0] as { type?: string; data?: Record<string, unknown> });
    const spawnEvent = events.find((event) => event.type === 'a2a.spawn');
    const sendEvent = events.find((event) => event.type === 'a2a.send');
    const spawnResult = events.find((event) => event.type === 'a2a.spawn_result');

    expect(spawnEvent).toBeDefined();
    expect(sendEvent).toBeDefined();
    expect(spawnResult).toBeDefined();

    expect(spawnEvent?.data?.fromAgent).toBe('planner');
    expect(spawnEvent?.data?.toAgent).toBe('worker-deep');
    expect(typeof spawnEvent?.data?.conversationId).toBe('string');
    expect(sendEvent?.data?.conversationId).toBe(spawnEvent?.data?.conversationId);
    expect(spawnResult?.data?.conversationId).toBe(spawnEvent?.data?.conversationId);

    expect(spawnResult?.data?.status).toBe('accepted');
    expect(spawnResult?.data?.runId).toBe('run-123');

    expect(mockRegisterSubagentRun).toHaveBeenCalledTimes(1);
    expect(mockRegisterSubagentRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'run-123',
        conversationId: spawnEvent?.data?.conversationId,
        requesterAgentId: 'planner',
        targetAgentId: 'worker-deep',
      }),
    );
  });

  it('emits spawn_result(error) when child run dispatch fails', async () => {
    mockCallGateway.mockRejectedValueOnce(new Error('gateway unavailable'));

    const tool = createSessionsSpawnTool({
      agentSessionKey: 'agent:planner:main',
    });

    const result = await tool.execute('call-2', {
      task: 'Dispatch this task',
      agentId: 'worker-quick',
    });

    expect((result as { details?: { status?: string } }).details?.status).toBe('error');

    const spawnResult = mockEmit.mock.calls.find(
      (call: unknown[]) => (call[0] as { type?: string }).type === 'a2a.spawn_result',
    )?.[0] as { data?: Record<string, unknown> } | undefined;

    expect(spawnResult).toBeDefined();
    expect(spawnResult?.data?.status).toBe('error');
    expect(spawnResult?.data?.error).toBe('gateway unavailable');
    expect(mockRegisterSubagentRun).not.toHaveBeenCalled();
  });
});
