import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

const TASK_HUB_URL = process.env.TASK_HUB_URL || "http://localhost:3102";
const INTERNAL_TOKEN = "pronto-dashboard-agent-token-2026";

const AVAILABLE_TOPICS = [
  "dev-backlog (개발 백로그)",
  "collab-debug (협업 디버깅)",
  "project-design (프로젝트 설계)",
  "product-marketing (제품 마케팅)",
  "metrics-budget (지표 및 예산)",
  "marketing-analysis (마케팅 분석)",
  "key-decisions (핵심 결정사항)",
  "infra-ops (인프라 운영)",
  "code-review (코드 리뷰)",
].join(", ");

export default function register(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      if (ctx.sandboxed) return null;
      const agentId = ctx.agentId || "unknown";

      return {
        name: "send_to_dashboard",
        description: `Send a message to the Task Hub dashboard operator. You can send to a specific topic channel or as a direct message. Available topic channels: ${AVAILABLE_TOPICS}. The operator will see your message and can respond. Use topicId to route to the appropriate channel.`,
        parameters: {
          type: "object" as const,
          properties: {
            message: {
              type: "string",
              description: "The message content to send to the dashboard operator",
            },
            topicId: {
              type: "string",
              description: "Optional topic channel ID. One of: dev-backlog, collab-debug, project-design, product-marketing, metrics-budget, marketing-analysis, key-decisions, infra-ops, code-review. If omitted, sends as a direct message.",
            },
            severity: {
              type: "string",
              enum: ["info", "warning", "error", "question"],
              description: "Message severity level. Defaults to info.",
            },
            conversationId: {
              type: "string",
              description: "Optional existing conversation ID to continue a thread. If omitted, creates a new conversation.",
            },
          },
          required: ["message"],
        },
        async execute(
          _id: string,
          params: Record<string, unknown>,
        ) {
          const message = params.message as string;
          const topicId = params.topicId as string | undefined;
          const severity = (params.severity as string) || "info";
          const conversationId = params.conversationId as string | undefined;

          try {
            const body: Record<string, unknown> = {
              agentId,
              message,
              severity,
            };
            if (topicId) body.topicId = topicId;
            if (conversationId) body.conversationId = conversationId;

            const res = await fetch(`${TASK_HUB_URL}/api/dm/incoming`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "x-internal-token": INTERNAL_TOKEN,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10000),
            });

            if (!res.ok) {
              const text = await res.text();
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `Failed to send to dashboard: HTTP ${res.status} - ${text}`,
                  },
                ],
              };
            }

            const data = await res.json();
            const target = topicId ? `topic channel "${topicId}"` : "direct message";
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Message sent to dashboard ${target}. conversationId: ${data.conversationId || "new"}. The operator will see your message and may respond.`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error sending to dashboard: ${String(error)}`,
                },
              ],
            };
          }
        },
      };
    },
    { optional: true, name: "send_to_dashboard" },
  );
}
