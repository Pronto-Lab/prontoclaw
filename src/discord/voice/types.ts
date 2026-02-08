import type { OpenClawConfig } from "../../config/config.js";

export type VoiceSessionState = "idle" | "listening" | "processing" | "speaking";

export type VoiceSessionConfig = {
  guildId: string;
  channelId: string;
  botUserId: string;
  cfg: OpenClawConfig;
  deepgramApiKey: string;
  sessionKey: string;
  agentId?: string;
};

export type TranscriptEvent = {
  text: string;
  isFinal: boolean;
  confidence: number;
  userId: string;
};

export type SpeechSegment = {
  text: string;
  audioBuffer: Buffer;
  sampleRate: number;
};

export type VoiceSessionEvents = {
  audioData: (pcmBuffer: Buffer, userId: string) => void;
  userJoined: (userId: string) => void;
  userLeft: (userId: string) => void;
  stateChanged: (from: VoiceSessionState, to: VoiceSessionState) => void;
  partialTranscript: (event: TranscriptEvent) => void;
  finalTranscript: (event: TranscriptEvent) => void;
  utteranceEnd: (text: string, userId: string) => void;
  textChunk: (text: string) => void;
  responseStart: () => void;
  responseEnd: () => void;
  speakingStart: () => void;
  speakingEnd: () => void;
  error: (error: Error) => void;
};
