/**
 * Sibling Bot Registry
 *
 * Tracks Discord bot user IDs of sibling agents in the same deployment.
 * Messages from sibling bots bypass the standard bot-drop filter so that
 * multi-agent setups can communicate within guild channels.
 */

const siblingBotIds = new Set<string>();

/** Register a bot user ID as a sibling agent. */
export function registerSiblingBot(botId: string): void {
  if (botId) {
    siblingBotIds.add(botId);
  }
}

/** Unregister a bot user ID when an account disconnects. */
export function unregisterSiblingBot(botId: string): void {
  siblingBotIds.delete(botId);
}

/** Check whether a user ID belongs to a registered sibling bot. */
export function isSiblingBot(userId: string): boolean {
  return siblingBotIds.has(userId);
}

/** Return all registered sibling bot IDs (for diagnostics). */
export function listSiblingBots(): string[] {
  return [...siblingBotIds];
}

/** Clear all registrations (for tests). */
export function clearSiblingBots(): void {
  siblingBotIds.clear();
}
