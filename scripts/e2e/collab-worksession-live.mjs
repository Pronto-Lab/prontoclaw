import fs from "node:fs";

const gatewayUrl = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const monitorUrl = process.env.TASK_MONITOR_URL || "http://127.0.0.1:3847";
const taskHubSessionCookie =
  process.env.TASK_HUB_SESSION_COOKIE || "task-hub-session=authenticated";
const taskHubCandidateUrls = [
  process.env.TASK_HUB_URL,
  "http://127.0.0.1:3102",
  "http://localhost:3102",
].filter(Boolean);

const cfg = JSON.parse(fs.readFileSync("/Users/server/.openclaw/openclaw.json", "utf8"));
const gatewayToken = cfg?.gateway?.auth?.token;
if (!gatewayToken) {
  throw new Error("gateway token missing");
}

const authHeaders = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${gatewayToken}`,
};

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${url}: ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
}

async function resolveTaskHubUrl() {
  for (const baseUrl of taskHubCandidateUrls) {
    try {
      const res = await fetch(`${baseUrl}/login`, { redirect: "manual" });
      const text = await res.text();
      if (res.status >= 200 && res.status < 400 && /Task Hub/i.test(text)) {
        return baseUrl;
      }
    } catch {
      // keep trying candidates
    }
  }
  throw new Error(
    `Unable to resolve Task-Hub URL. Tried: ${taskHubCandidateUrls.join(", ")}. ` +
      `Expected Task-Hub login page (title includes "Task Hub").`,
  );
}

async function fetchTaskHubEvents(taskHubUrl, limit = 700, extraQuery = "") {
  const query = extraQuery ? `&${extraQuery.replace(/^&/, "")}` : "";
  const res = await fetch(`${taskHubUrl}/api/proxy/events?limit=${limit}${query}`, {
    headers: {
      Cookie: taskHubSessionCookie,
      Accept: "application/json",
    },
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Invalid JSON from ${taskHubUrl}/api/proxy/events: ${text.slice(0, 300)}`);
  }

  if (res.status === 401) {
    throw new Error(
      `Task-Hub auth failed (401). Set TASK_HUB_SESSION_COOKIE or login first. ` +
        `Current cookie: ${taskHubSessionCookie}`,
    );
  }

  if (res.status === 404) {
    throw new Error(
      `Task-Hub route mismatch (404): ${taskHubUrl}/api/proxy/events. ` +
        `Response: ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  if (!res.ok) {
    throw new Error(
      `Task-Hub events fetch failed (${res.status}): ${JSON.stringify(json).slice(0, 300)}`,
    );
  }

  return Array.isArray(json?.events) ? json.events : [];
}

async function invokeTool(tool, args = {}, agentId = "ruda") {
  return fetchJson(`${gatewayUrl}/tools/invoke`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      tool,
      args,
      sessionKey: `agent:${agentId}:main`,
    }),
  });
}

function detailsFromInvokeResult(result, toolName) {
  const details = result?.result?.details;
  if (!details) {
    throw new Error(
      `Missing result.details for ${toolName}: ${JSON.stringify(result).slice(0, 500)}`,
    );
  }
  return details;
}

async function fetchEvents(limit = 600) {
  const json = await fetchJson(`${monitorUrl}/api/events?limit=${limit}`);
  return Array.isArray(json?.events) ? json.events : [];
}

function conversationEvents(events, conversationId) {
  return events.filter((evt) => {
    const data = evt?.data ?? {};
    return data.conversationId === conversationId || data.parentConversationId === conversationId;
  });
}

function findLatest(events, type) {
  return events
    .filter((evt) => evt?.type === type)
    .toSorted((a, b) => (a?.ts ?? 0) - (b?.ts ?? 0))
    .at(-1);
}

async function waitForConversationChain(conversationId, timeoutMs = 210_000) {
  const start = Date.now();
  let last = [];
  while (Date.now() - start <= timeoutMs) {
    const all = await fetchEvents(700);
    const conv = conversationEvents(all, conversationId);
    if (conv.length > 0) {
      last = conv;
      const types = new Set(conv.map((evt) => evt?.type));
      const hasBase =
        types.has("a2a.spawn") &&
        types.has("a2a.send") &&
        types.has("a2a.spawn_result") &&
        types.has("a2a.complete");
      const hasReply = types.has("a2a.response") || types.has("continuation.sent");
      if (hasBase && hasReply) {
        return conv;
      }
    }
    await sleep(3_000);
  }
  const seen = Array.from(new Set(last.map((evt) => evt?.type)))
    .toSorted()
    .join(", ");
  throw new Error(
    `Timeout waiting conversation chain for ${conversationId}. Seen: ${seen || "none"}`,
  );
}

async function waitForMainConversationMarker(marker, timeoutMs = 180_000) {
  const start = Date.now();
  while (Date.now() - start <= timeoutMs) {
    const payload = await fetchJson(`${monitorUrl}/api/events?limit=700&role=conversation.main`);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const found = events.find((evt) => {
      const message = String(evt?.data?.message || "");
      const preview = String(evt?.data?.replyPreview || "");
      return message.includes(marker) || preview.includes(marker);
    });
    if (found) {
      return { events, found, payload };
    }
    await sleep(3_000);
  }
  throw new Error(`Timeout waiting conversation.main marker: ${marker}`);
}

function normalizeMessageText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncateText(value, maxLength = 64) {
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, maxLength - 1)}...`;
}

function resolveEventMessage(event) {
  const message =
    typeof event?.data?.message === "string" ? normalizeMessageText(event.data.message) : "";
  if (message) {
    return message;
  }
  const preview =
    typeof event?.data?.replyPreview === "string"
      ? normalizeMessageText(event.data.replyPreview)
      : "";
  if (preview) {
    return preview;
  }
  if (event?.type === "a2a.spawn_result") {
    if (event?.data?.status === "accepted") {
      return "작업이 수락되어 실행 중입니다";
    }
    if (event?.data?.status === "error") {
      return event?.data?.error ? `실행 실패: ${event.data.error}` : "실행 실패";
    }
  }
  return "";
}

function extractSessionSummaryText(raw) {
  const message = normalizeMessageText(raw);
  if (!message) {
    return null;
  }
  const lower = message.toLowerCase();
  if (lower.startsWith("spawn accepted") || lower === "work session") {
    return null;
  }

  const goalMatch = message.match(/\[goal\]\s*(.+?)(?=\s*\[[a-z]+\]|$)/i);
  const quotedTask = message.match(/"([^"]{4,160})"/);
  let summary = quotedTask?.[1] ?? goalMatch?.[1] ?? message;

  summary = summary
    .replace(/^A (subagent task|cron job)\s*/i, "")
    .replace(/\s*just\s+(completed successfully|timed out|failed:[^.]+)\.?$/i, "")
    .replace(/\s*[-·]\s*run\s+[a-z0-9-]+$/i, "")
    .trim();

  if (!summary || summary.toUpperCase() === "NO_REPLY") {
    return null;
  }
  const summaryLower = summary.toLowerCase();
  if (summaryLower === "work session" || summary === "협업 작업") {
    return null;
  }
  return truncateText(summary);
}

function formatSessionLabel(label) {
  if (!label) {
    return null;
  }
  const cleaned = normalizeMessageText(label).replace(/[-_]+/g, " ");
  if (!cleaned || cleaned.length < 3) {
    return null;
  }
  const lower = cleaned.toLowerCase();
  if (lower === "work session" || lower === "협업 작업" || /^work session(\b|$)/i.test(cleaned)) {
    return null;
  }
  return truncateText(cleaned);
}

function sessionEventPriority(type) {
  if (type === "a2a.spawn") {
    return 0;
  }
  if (type === "a2a.send") {
    return 1;
  }
  if (type === "continuation.sent") {
    return 2;
  }
  if (type === "a2a.response") {
    return 3;
  }
  return 9;
}

function getEventTimestamp(event) {
  return (
    event?.ts || event?.timestampMs || (event?.timestamp ? new Date(event.timestamp).getTime() : 0)
  );
}

function summarizeSessionWork(threads) {
  const candidates = [];
  for (const thread of threads) {
    for (const event of thread.events) {
      const ts = getEventTimestamp(event);
      const labelSummary = formatSessionLabel(event?.data?.label);
      if (labelSummary) {
        candidates.push({ text: labelSummary, priority: -1, ts });
      }
      const summary = extractSessionSummaryText(resolveEventMessage(event));
      if (summary) {
        candidates.push({ text: summary, priority: sessionEventPriority(event.type), ts });
      }
    }
  }

  if (candidates.length === 0) {
    const fallback = extractSessionSummaryText(threads[0]?.firstMessage || "");
    return fallback || "협업 작업";
  }

  candidates.sort((a, b) => a.priority - b.priority || a.ts - b.ts);
  return candidates[0].text;
}

function groupEvents(events) {
  const threadMap = new Map();
  const TEMPORAL_THRESHOLD = 5 * 60 * 1000;

  for (const event of events) {
    const fromAgent =
      event?.data?.fromAgent || event?.data?.senderAgentId || event?.agentId || "unknown";
    const toAgent = event?.data?.toAgent || event?.data?.targetAgentId || "unknown";
    const conversationId = event?.data?.conversationId;
    const ws =
      typeof event?.data?.workSessionId === "string" ? event.data.workSessionId.trim() : "";
    const workSessionId = ws || undefined;
    const timestamp = getEventTimestamp(event);
    const message = resolveEventMessage(event);

    let threadId = "";
    if (conversationId) {
      threadId = conversationId;
    } else {
      const pairKey = [fromAgent, toAgent].toSorted().join("_");
      let foundId = "";
      for (const [id, thread] of threadMap.entries()) {
        if (id.startsWith(pairKey) && Math.abs(timestamp - thread.lastTime) < TEMPORAL_THRESHOLD) {
          foundId = id;
          break;
        }
      }
      threadId = foundId || `${pairKey}_${timestamp}`;
    }

    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, {
        id: threadId,
        conversationId,
        workSessionId,
        fromAgent,
        toAgent,
        events: [],
        startTime: timestamp,
        lastTime: timestamp,
        firstMessage: message,
      });
    }

    const thread = threadMap.get(threadId);
    thread.events.push(event);
    if (!thread.workSessionId && workSessionId) {
      thread.workSessionId = workSessionId;
    }
    thread.lastTime = Math.max(thread.lastTime, timestamp);
    if (!thread.firstMessage && message) {
      thread.firstMessage = message;
    }
  }

  const threads = Array.from(threadMap.values()).toSorted((a, b) => b.startTime - a.startTime);
  const sessionsByWs = new Map();
  for (const thread of threads) {
    if (!thread.workSessionId) {
      continue;
    }
    const key = thread.workSessionId;
    if (!sessionsByWs.has(key)) {
      sessionsByWs.set(key, { workSessionId: key, threads: [] });
    }
    sessionsByWs.get(key).threads.push(thread);
  }
  return sessionsByWs;
}

async function findAgentWithoutCurrentTask() {
  const candidates = [
    "ieum",
    "nuri",
    "hangyeol",
    "grim",
    "onsae",
    "miri",
    "yunseul",
    "seum",
    "eden",
  ];
  for (const agent of candidates) {
    try {
      const resp = await invokeTool("task_status", {}, agent);
      const d = resp?.result?.details;
      if (!d?.found || !d?.task?.id) {
        return agent;
      }
    } catch {
      return agent;
    }
  }
  return null;
}

async function runCase(name, agentId, args, expectations, caseReports) {
  const invokeResp = await invokeTool("sessions_spawn", args, agentId);
  const details = detailsFromInvokeResult(invokeResp, "sessions_spawn");

  assert(details.status === "accepted", `${name}: spawn status not accepted (${details.status})`);
  assert(details.conversationId === args.parentConversationId, `${name}: conversationId mismatch`);

  const events = await waitForConversationChain(details.conversationId);
  const spawnEvent = findLatest(events, "a2a.spawn");
  const sendEvent = findLatest(events, "a2a.send");
  const spawnResult = findLatest(events, "a2a.spawn_result");
  const responseEvent =
    findLatest(events, "a2a.response") || findLatest(events, "continuation.sent");
  const completeEvent = findLatest(events, "a2a.complete");

  assert(spawnEvent, `${name}: missing a2a.spawn`);
  assert(sendEvent, `${name}: missing a2a.send`);
  assert(spawnResult, `${name}: missing a2a.spawn_result`);
  assert(completeEvent, `${name}: missing a2a.complete`);
  assert(
    (spawnResult?.data?.status || "") === "accepted",
    `${name}: spawn_result status not accepted`,
  );
  assert(responseEvent, `${name}: missing reply-like event`);

  const preview = responseEvent?.data?.replyPreview;
  assert(typeof preview === "string" && preview.trim().length > 0, `${name}: empty replyPreview`);

  expectations({ details, spawnEvent, sendEvent, spawnResult, responseEvent, completeEvent });

  caseReports.push({
    name,
    conversationId: details.conversationId,
    workSessionId: details.workSessionId,
    taskId: details.taskId,
    runId: details.runId,
    replyPreview: String(preview).slice(0, 120),
  });

  return details;
}

async function main() {
  const runTag = Date.now();
  const tasksToComplete = [];
  const caseReports = [];

  try {
    const taskHubUrl = await resolveTaskHubUrl();
    console.log(`[E2E] start runTag=${runTag}`);
    console.log(`[E2E] taskHubUrl=${taskHubUrl}`);

    const taskStart = detailsFromInvokeResult(
      await invokeTool("task_start", { description: `E2E all-cases validation ${runTag}` }, "ruda"),
      "task_start",
    );
    assert(taskStart.success === true, "task_start success=false");
    assert(
      typeof taskStart.taskId === "string" && taskStart.taskId.startsWith("task_"),
      "task_start taskId invalid",
    );
    assert(
      typeof taskStart.workSessionId === "string" && taskStart.workSessionId.startsWith("ws_"),
      "task_start workSessionId invalid",
    );
    tasksToComplete.push({ agentId: "ruda", taskId: taskStart.taskId });

    const taskStatus = detailsFromInvokeResult(
      await invokeTool("task_status", { task_id: taskStart.taskId }, "ruda"),
      "task_status",
    );
    assert(taskStatus.found === true, "task_status found=false");
    assert(
      taskStatus?.task?.workSessionId === taskStart.workSessionId,
      "task_status workSessionId mismatch",
    );

    const monitorTask = await fetchJson(`${monitorUrl}/api/agents/ruda/tasks/${taskStart.taskId}`);
    assert(
      monitorTask?.task?.workSessionId === taskStart.workSessionId,
      "task-monitor parser workSessionId mismatch",
    );

    const baseTaskId = taskStart.taskId;
    const baseWs = taskStart.workSessionId;

    await runCase(
      "CaseA-explicit",
      "ruda",
      {
        task: `[goal] Case A ${runTag} explicit metadata. Reply exactly "A-${runTag}" and stop.`,
        label: `E2E Case A explicit ${runTag}`,
        taskId: baseTaskId,
        workSessionId: baseWs,
        parentConversationId: `conv-e2e-a-${runTag}`,
        depth: 1,
        hop: 2,
        agentId: "worker-quick",
        runTimeoutSeconds: 90,
      },
      ({ details, spawnEvent }) => {
        assert(details.taskId === baseTaskId, "CaseA taskId mismatch");
        assert(details.workSessionId === baseWs, "CaseA ws mismatch");
        assert(spawnEvent?.data?.taskId === baseTaskId, "CaseA spawn.taskId mismatch");
        assert(spawnEvent?.data?.workSessionId === baseWs, "CaseA spawn.ws mismatch");
        assert(spawnEvent?.data?.depth === 1, "CaseA depth mismatch");
        assert(spawnEvent?.data?.hop === 2, "CaseA hop mismatch");
      },
      caseReports,
    );

    await runCase(
      "CaseB-taskId-inferWs",
      "ruda",
      {
        task: `[goal] Case B ${runTag} infer ws from taskId. Reply exactly "B-${runTag}" and stop.`,
        label: `E2E Case B infer ${runTag}`,
        taskId: baseTaskId,
        parentConversationId: `conv-e2e-b-${runTag}`,
        agentId: "worker-deep",
        runTimeoutSeconds: 90,
      },
      ({ details, spawnEvent }) => {
        assert(details.taskId === baseTaskId, "CaseB taskId mismatch");
        assert(details.workSessionId === baseWs, "CaseB ws mismatch");
        assert(spawnEvent?.data?.workSessionId === baseWs, "CaseB spawn.ws mismatch");
      },
      caseReports,
    );

    await runCase(
      "CaseC-currentTask-infer",
      "ruda",
      {
        task: `[goal] Case C ${runTag} infer from current task. Reply exactly "C-${runTag}" and stop.`,
        label: `E2E Case C current ${runTag}`,
        parentConversationId: `conv-e2e-c-${runTag}`,
        agentId: "worker-quick",
        runTimeoutSeconds: 90,
      },
      ({ details, spawnEvent }) => {
        assert(details.taskId === baseTaskId, "CaseC taskId mismatch");
        assert(details.workSessionId === baseWs, "CaseC ws mismatch");
        assert(spawnEvent?.data?.taskId === baseTaskId, "CaseC spawn.taskId mismatch");
        assert(spawnEvent?.data?.workSessionId === baseWs, "CaseC spawn.ws mismatch");
      },
      caseReports,
    );

    const fallbackAgent = await findAgentWithoutCurrentTask();
    assert(fallbackAgent, "No agent available for fallback case");

    const caseD = await runCase(
      "CaseD-fallback-randomWs",
      fallbackAgent,
      {
        task: `[goal] Case D ${runTag} fallback ws. Reply exactly "D-${runTag}" and stop.`,
        label: `E2E Case D fallback ${runTag}`,
        parentConversationId: `conv-e2e-d-${runTag}`,
        agentId: "worker-quick",
        runTimeoutSeconds: 90,
      },
      ({ details, spawnEvent }) => {
        assert(
          typeof details.workSessionId === "string" && details.workSessionId.startsWith("ws_"),
          "CaseD ws not generated",
        );
        assert(!details.taskId, `CaseD expected empty taskId but got ${details.taskId}`);
        assert(
          spawnEvent?.data?.workSessionId === details.workSessionId,
          "CaseD spawn.ws mismatch",
        );
      },
      caseReports,
    );

    const sendMarker = `[goal] MAIN-MAIN-${runTag} 코드 구현 상태 공유`;
    const sendMainResp = detailsFromInvokeResult(
      await invokeTool(
        "sessions_send",
        {
          sessionKey: "agent:eden:main",
          message: sendMarker,
          timeoutSeconds: 0,
          taskId: baseTaskId,
          workSessionId: baseWs,
          parentConversationId: `conv-e2e-main-${runTag}`,
        },
        "ruda",
      ),
      "sessions_send",
    );
    assert(
      sendMainResp.status === "accepted" || sendMainResp.status === "ok",
      `main-main sessions_send failed (${sendMainResp.status})`,
    );

    const roleProbe = await waitForMainConversationMarker(`MAIN-MAIN-${runTag}`);
    assert(roleProbe.found?.eventRole === "conversation.main", "main-main eventRole mismatch");
    assert(
      roleProbe.found?.collabCategory === "engineering_build",
      `main-main category mismatch: ${roleProbe.found?.collabCategory}`,
    );

    const conversationRolePayload = await fetchJson(
      `${monitorUrl}/api/events?limit=700&role=conversation.main`,
    );
    const conversationRoleEvents = Array.isArray(conversationRolePayload?.events)
      ? conversationRolePayload.events
      : [];
    assert(conversationRoleEvents.length > 0, "role=conversation.main returned no events");
    assert(
      conversationRoleEvents.every((evt) => evt?.eventRole === "conversation.main"),
      "role=conversation.main returned mixed roles",
    );
    assert(
      conversationRoleEvents.every(
        (evt) => evt?.type !== "a2a.spawn" && evt?.type !== "a2a.spawn_result",
      ),
      "role=conversation.main leaked spawn events",
    );

    const delegationRolePayload = await fetchJson(
      `${monitorUrl}/api/events?limit=700&role=delegation.subagent`,
    );
    const delegationRoleEvents = Array.isArray(delegationRolePayload?.events)
      ? delegationRolePayload.events
      : [];
    assert(delegationRoleEvents.length > 0, "role=delegation.subagent returned no events");
    assert(
      delegationRoleEvents.some((evt) => evt?.type === "a2a.spawn"),
      "delegation.subagent stream missing spawn event",
    );

    const engCategoryPayload = await fetchJson(
      `${monitorUrl}/api/events?limit=700&role=conversation.main&viewCategory=engineering_build`,
    );
    const engCategoryEvents = Array.isArray(engCategoryPayload?.events)
      ? engCategoryPayload.events
      : [];
    assert(engCategoryEvents.length > 0, "viewCategory=engineering_build returned no events");
    assert(
      engCategoryEvents.every((evt) => evt?.collabCategory === "engineering_build"),
      "viewCategory filter returned non-engineering category",
    );

    const taskHubEvents = await fetchTaskHubEvents(taskHubUrl, 700);
    const collabEvents = taskHubEvents.filter((e) => String(e?.type || "").startsWith("a2a."));
    const sessionMap = groupEvents(collabEvents);

    const baseSession = sessionMap.get(baseWs);
    assert(
      baseSession && baseSession.threads.length > 0,
      "Task-hub grouping missing base workSessionId",
    );
    const baseSummary = summarizeSessionWork(baseSession.threads);
    assert(
      baseSummary && baseSummary !== "협업 작업" && !/^work session$/i.test(baseSummary),
      "Task-hub base summary is generic",
    );

    const dSession = sessionMap.get(caseD.workSessionId);
    assert(
      dSession && dSession.threads.length > 0,
      "Task-hub grouping missing fallback workSessionId",
    );
    const dSummary = summarizeSessionWork(dSession.threads);
    assert(
      dSummary && dSummary !== "협업 작업" && !/^work session$/i.test(dSummary),
      "Task-hub fallback summary is generic",
    );

    const taskHubMainView = await fetchTaskHubEvents(
      taskHubUrl,
      500,
      "role=conversation.main&viewCategory=engineering_build",
    );
    assert(taskHubMainView.length > 0, "Task-Hub proxy role+viewCategory returned empty");
    assert(
      taskHubMainView.every((evt) => evt?.eventRole === "conversation.main"),
      "Task-Hub proxy role=conversation.main returned mixed roles",
    );

    console.log("[E2E] PASS");
    console.log(
      JSON.stringify(
        {
          runTag,
          taskHubUrl,
          taskStart: {
            taskId: baseTaskId,
            workSessionId: baseWs,
          },
          fallbackAgent,
          baseSummary,
          fallbackSummary: dSummary,
          roleCheck: {
            conversationMainCount: conversationRoleEvents.length,
            delegationCount: delegationRoleEvents.length,
            engineeringCategoryCount: engCategoryEvents.length,
          },
          cases: caseReports,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error("[E2E] FAIL", error?.stack || error);
    process.exitCode = 1;
  } finally {
    for (const entry of tasksToComplete) {
      try {
        await invokeTool(
          "task_complete",
          {
            task_id: entry.taskId,
            summary: `E2E cleanup ${runTag}`,
          },
          entry.agentId,
        );
        console.log(`[E2E] cleanup completed task ${entry.taskId}`);
      } catch (error) {
        console.error(`[E2E] cleanup failed for ${entry.taskId}:`, error?.message || error);
      }
    }
  }
}

await main();
