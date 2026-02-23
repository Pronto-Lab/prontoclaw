/**
 * Sibling Bot Registry
 *
 * Tracks Discord bot user IDs of sibling agents in the same deployment.
 * Messages from sibling bots bypass the standard bot-drop filter so that
 * multi-agent setups can communicate within guild channels.
 *
 * Also maps bot user IDs to their owning agent IDs so that the
 * auto-routing layer can resolve the sender agent for A2A flows.
 */

/** Map from Discord bot user ID → agent ID. */
const siblingBotMap = new Map<string, string>();

/** Register a bot user ID as a sibling agent. */
export function registerSiblingBot(botId: string, agentId?: string): void {
  if (botId) {
    siblingBotMap.set(botId, agentId ?? "");
  }
}

/** Unregister a bot user ID when an account disconnects. */
export function unregisterSiblingBot(botId: string): void {
  siblingBotMap.delete(botId);
}

/** Check whether a user ID belongs to a registered sibling bot. */
export function isSiblingBot(userId: string): boolean {
  return siblingBotMap.has(userId);
}

/**
 * Resolve the agent ID that owns a given Discord bot user ID.
 * Returns `undefined` if the bot is not registered or has no agent mapping.
 */
export function getAgentIdForBot(botUserId: string): string | undefined {
  const agentId = siblingBotMap.get(botUserId);
  return agentId || undefined;
}

/** Resolve the Discord bot user ID for a given agent ID. */
export function getBotUserIdForAgent(agentId: string): string | undefined {
  for (const [botId, agent] of siblingBotMap) {
    if (agent === agentId) {
      return botId;
    }
  }
  return undefined;
}

/** Return all registered sibling bot IDs (for diagnostics). */
export function listSiblingBots(): string[] {
  return [...siblingBotMap.keys()];
}

/** Clear all registrations (for tests). */
export function clearSiblingBots(): void {
  siblingBotMap.clear();
}
