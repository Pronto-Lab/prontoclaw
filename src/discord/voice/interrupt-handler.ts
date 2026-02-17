import { EventEmitter } from "node:events";
import type { SpeechToText } from "./speech-to-text.js";
import type { TextToSpeech } from "./text-to-speech.js";
import type { VoiceBridge } from "./voice-bridge.js";
import type { VoiceSessionManager } from "./voice-session.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEFAULT_INTERRUPT_THRESHOLD_MS = 300;
const DEFAULT_COOLDOWN_MS = 500;

export interface InterruptHandlerConfig {
  voiceSession: VoiceSessionManager;
  tts: TextToSpeech;
  bridge: VoiceBridge;
  stt: SpeechToText;
  interruptThresholdMs?: number;
  cooldownMs?: number;
}

export interface InterruptInfo {
  playedText: string;
}

export interface InterruptHandlerEvents {
  interrupted: [info: InterruptInfo];
  interruptCancelled: [];
}

// ---------------------------------------------------------------------------
// InterruptHandler — detects user barge-in during bot speech and stops TTS
// ---------------------------------------------------------------------------

export class InterruptHandler extends EventEmitter<InterruptHandlerEvents> {
  private readonly voiceSession: VoiceSessionManager;
  private readonly tts: TextToSpeech;
  private readonly bridge: VoiceBridge;
  private readonly stt: SpeechToText;
  private readonly interruptThresholdMs: number;
  private readonly cooldownMs: number;

  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private inCooldown = false;
  private started = false;

  /** Bound listener references for cleanup */
  private readonly boundOnAudioData: (pcmBuffer: Buffer, userId: string) => void;
  private readonly boundOnStateChanged: (from: string, to: string) => void;

  constructor(config: InterruptHandlerConfig) {
    super();
    this.voiceSession = config.voiceSession;
    this.tts = config.tts;
    this.bridge = config.bridge;
    this.stt = config.stt;
    this.interruptThresholdMs = config.interruptThresholdMs ?? DEFAULT_INTERRUPT_THRESHOLD_MS;
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;

    this.boundOnAudioData = this.onAudioData.bind(this);
    this.boundOnStateChanged = this.onStateChanged.bind(this);
  }

  // ---- public API --------------------------------------------------------

  /**
   * Start listening for interrupt conditions.
   * Wires up event listeners on the voice session.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    this.voiceSession.on("audioData", this.boundOnAudioData);
    this.voiceSession.on("stateChanged", this.boundOnStateChanged);
  }

  /**
   * Stop listening and clean up all timers and listeners.
   */
  stop(): void {
    if (!this.started) {
      return;
    }
    this.started = false;

    this.voiceSession.removeListener("audioData", this.boundOnAudioData);
    this.voiceSession.removeListener("stateChanged", this.boundOnStateChanged);

    this.cancelPendingInterrupt();
    this.clearCooldown();
  }

  // ---- event handlers (bound in constructor) -----------------------------

  private onAudioData(_pcmBuffer: Buffer, _userId: string): void {
    if (this.voiceSession.getState() === "speaking") {
      this.handlePotentialInterrupt();
    }
  }

  private onStateChanged(_from: string, to: string): void {
    // If the bot is no longer speaking, cancel any pending interrupt
    if (to !== "speaking") {
      this.cancelPendingInterrupt();
    }
  }

  // ---- interrupt logic ---------------------------------------------------

  /**
   * Called when user audio arrives while bot is speaking.
   * Starts a debounce timer; if audio continues past the threshold, execute
   * the interrupt sequence.
   */
  private handlePotentialInterrupt(): void {
    // Guard: must be in speaking state
    if (this.voiceSession.getState() !== "speaking") {
      return;
    }

    // Guard: cooldown active
    if (this.inCooldown) {
      return;
    }

    // Guard: already waiting for threshold
    if (this.debounceTimer !== null) {
      return;
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.executeInterrupt();
    }, this.interruptThresholdMs);
  }

  /**
   * Execute the interrupt sequence (order matters):
   * 1. Capture played text
   * 2. Stop TTS playback
   * 3. Abort in-flight LLM response
   * 4. Transition state to listening
   * 5. Start cooldown
   * 6. Emit event
   */
  private executeInterrupt(): void {
    // Final guard: state may have changed during the debounce window
    if (this.voiceSession.getState() !== "speaking") {
      return;
    }

    // 1. Capture what was actually played before we stop
    const playedText = this.tts.getPlayedText();

    // 2. Stop TTS playback and clear queue
    this.tts.stop();

    // 3. Abort the in-flight Claude response
    this.bridge.abort();

    // 4. Transition voice session to listening
    this.voiceSession.setState("listening");

    // 5. Start cooldown to prevent rapid repeated interrupts
    this.startCooldown();

    // 6. Notify consumers
    this.emit("interrupted", { playedText });
  }

  /**
   * Cancel a pending interrupt (audio stopped before threshold reached).
   */
  private cancelPendingInterrupt(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.emit("interruptCancelled");
    }
  }

  // ---- cooldown ----------------------------------------------------------

  private startCooldown(): void {
    this.inCooldown = true;
    this.cooldownTimer = setTimeout(() => {
      this.inCooldown = false;
      this.cooldownTimer = null;
    }, this.cooldownMs);
  }

  private clearCooldown(): void {
    if (this.cooldownTimer !== null) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = null;
    }
    this.inCooldown = false;
  }
}
