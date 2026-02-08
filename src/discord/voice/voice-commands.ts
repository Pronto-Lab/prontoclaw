import type { DiscordGatewayAdapterCreator } from "@discordjs/voice";
import type { OpenClawConfig } from "../../config/config.js";
import type { VoiceSessionConfig } from "./types.js";
import { SpeechToText } from "./speech-to-text.js";
import { TextToSpeech } from "./text-to-speech.js";
import { VoiceBridge } from "./voice-bridge.js";
import { VoiceSessionManager } from "./voice-session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VoicePipelineHandle = {
  voiceSession: VoiceSessionManager;
  stt: SpeechToText;
  bridge: VoiceBridge;
  tts: TextToSpeech;
  interrupt: InterruptHandler;
  destroy: () => void;
};

type InitVoicePipelineParams = {
  guildId: string;
  channelId: string;
  botUserId: string;
  userId: string;
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  accountId?: string;
  adapterCreator: DiscordGatewayAdapterCreator;
  deepgramApiKey: string;
};

type HandleVoiceStateUpdateParams = {
  oldChannelId?: string | null;
  newChannelId?: string | null;
  userId: string;
  guildId: string;
  botUserId: string;
  targetChannelId: string;
  currentPipeline: VoicePipelineHandle | null;
  onJoinNeeded: () => Promise<void>;
  onLeaveNeeded: () => void;
};

// ---------------------------------------------------------------------------
// initVoicePipeline — wire up every component and return a handle
// ---------------------------------------------------------------------------

export async function initVoicePipeline(
  params: InitVoicePipelineParams,
): Promise<VoicePipelineHandle> {
  const {
    guildId,
    channelId,
    botUserId,
    userId,
    cfg,
    sessionKey,
    agentId,
    accountId,
    adapterCreator,
    deepgramApiKey,
  } = params;

  // 1. Create & join voice session
  const voiceSessionConfig: VoiceSessionConfig = {
    guildId,
    channelId,
    botUserId,
    cfg,
    deepgramApiKey,
    sessionKey,
    agentId,
  };
  const voiceSession = new VoiceSessionManager(voiceSessionConfig);
  await voiceSession.joinChannel(adapterCreator);

  // 2. Create STT
  const stt = new SpeechToText({ apiKey: deepgramApiKey, userId });
  await stt.start();

  // 3. Create VoiceBridge
  const bridge = new VoiceBridge({
    cfg,
    sessionKey,
    agentId,
    accountId,
    userId,
    guildId,
  });

  // 4. Create TTS (requires a live connection)
  const connection = voiceSession.getConnection();
  if (!connection) {
    throw new Error("[VoicePipeline] No voice connection available after joinChannel");
  }
  const tts = new TextToSpeech({ cfg, connection });

  // 5. Create InterruptHandler
  const interrupt = new InterruptHandler({
    voiceSession,
    tts,
    bridge,
    stt,
  });
  // 6. Wire up the pipeline
  //    audioData -> STT
  voiceSession.on("audioData", (buf: Buffer) => {
    stt.sendAudio(buf);
  });

  //    utteranceEnd -> VoiceBridge
  stt.on("utteranceEnd", (text: string) => {
    voiceSession.setState("processing");
    bridge.sendMessage(text).catch((err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[VoicePipeline] bridge.sendMessage failed", { error: error.message });
      voiceSession.setState("idle");
    });
  });

  //    responseStart -> speaking state
  bridge.on("responseStart", () => {
    voiceSession.setState("speaking");
  });

  //    textChunk -> TTS
  bridge.on("textChunk", (text: string) => {
    tts.speak(text);
  });

  //    speakingEnd -> idle state
  tts.on("speakingEnd", () => {
    voiceSession.setState("idle");
  });

  //    error forwarding
  voiceSession.on("error", (err: Error) => {
    console.error("[VoicePipeline] voiceSession error", { error: err.message });
  });
  stt.on("error", (err: Error) => {
    console.error("[VoicePipeline] stt error", { error: err.message });
  });
  bridge.on("error", (err: Error) => {
    console.error("[VoicePipeline] bridge error", { error: err.message });
  });
  tts.on("error", (err: Error) => {
    console.error("[VoicePipeline] tts error", { error: err.message });
  });

  // Start interrupt handler
  interrupt.start();

  // 7. Build handle
  const destroy = (): void => {
    destroyVoicePipeline({ voiceSession, stt, bridge, tts, interrupt, destroy });
  };

  return { voiceSession, stt, bridge, tts, interrupt, destroy };
}

// ---------------------------------------------------------------------------
// destroyVoicePipeline — tear down every component in order
// ---------------------------------------------------------------------------

export function destroyVoicePipeline(handle: VoicePipelineHandle): void {
  try {
    handle.interrupt.stop();
  } catch {
    // already stopped
  }
  try {
    handle.stt.stop();
  } catch {
    // already stopped
  }
  try {
    handle.tts.destroy();
  } catch {
    // already destroyed
  }
  try {
    handle.voiceSession.leaveChannel();
  } catch {
    // already left
  }
}

// ---------------------------------------------------------------------------
// handleVoiceStateUpdate — auto-join / auto-leave logic
// ---------------------------------------------------------------------------

export function handleVoiceStateUpdate(params: HandleVoiceStateUpdateParams): void {
  const {
    oldChannelId,
    newChannelId,
    userId,
    botUserId,
    targetChannelId,
    currentPipeline,
    onJoinNeeded,
    onLeaveNeeded,
  } = params;

  // Ignore the bot's own voice state updates for join/leave decisions
  // (but handle bot disconnect below)
  if (userId === botUserId) {
    // Bot itself was disconnected from the channel
    if (oldChannelId === targetChannelId && newChannelId !== targetChannelId) {
      if (currentPipeline) {
        onLeaveNeeded();
      }
    }
    return;
  }

  // User joined the target channel — start pipeline if not running
  if (newChannelId === targetChannelId && oldChannelId !== targetChannelId) {
    if (!currentPipeline) {
      onJoinNeeded().catch((err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error("[VoicePipeline] auto-join failed", { error: error.message });
      });
    }
    return;
  }

  // User left the target channel — if nobody else is there, leave
  if (oldChannelId === targetChannelId && newChannelId !== targetChannelId) {
    if (currentPipeline) {
      // The caller should check remaining members; we signal leave needed
      // since we can't access the channel member list from here.
      // The outer integration layer is responsible for counting members.
      onLeaveNeeded();
    }
    return;
  }
}
