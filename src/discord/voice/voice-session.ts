import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  type VoiceConnection,
  type VoiceConnectionState,
  type DiscordGatewayAdapterCreator,
} from "@discordjs/voice";
import { EventEmitter } from "node:events";
import { Transform, type TransformCallback } from "node:stream";
import * as prism from "prism-media";
import type { VoiceSessionConfig, VoiceSessionState, VoiceSessionEvents } from "./types.js";

// ---------------------------------------------------------------------------
// Valid state transitions
// ---------------------------------------------------------------------------
const VALID_TRANSITIONS: Record<VoiceSessionState, VoiceSessionState[]> = {
  idle: ["listening"],
  listening: ["processing", "idle"],
  processing: ["speaking", "idle"],
  speaking: ["idle", "listening"],
};

// ---------------------------------------------------------------------------
// PCM downsample transform: 48 kHz stereo -> 16 kHz mono (int16)
// ---------------------------------------------------------------------------
class PcmDownsampleTransform extends Transform {
  private remainder: Buffer = Buffer.alloc(0);

  /** Bytes per stereo sample-pair at 48 kHz (2 channels * 2 bytes) */
  private static readonly BYTES_PER_FRAME = 4;
  /** Down-sample factor: 48000 / 16000 = 3 */
  private static readonly FACTOR = 3;
  /** Bytes consumed per output sample: 3 stereo frames = 12 bytes */
  private static readonly STEP =
    PcmDownsampleTransform.BYTES_PER_FRAME * PcmDownsampleTransform.FACTOR;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    const input = Buffer.concat([this.remainder, chunk]);
    const step = PcmDownsampleTransform.STEP;
    const sampleCount = Math.floor(input.length / step);

    if (sampleCount === 0) {
      this.remainder = input;
      callback();
      return;
    }

    const out = Buffer.alloc(sampleCount * 2); // 2 bytes per mono int16 sample

    for (let i = 0; i < sampleCount; i++) {
      const offset = i * step;
      // Read the first stereo frame of the group and average L+R
      const left = input.readInt16LE(offset);
      const right = input.readInt16LE(offset + 2);
      const mono = Math.round((left + right) / 2);
      out.writeInt16LE(Math.max(-32768, Math.min(32767, mono)), i * 2);
    }

    this.remainder = input.subarray(sampleCount * step);
    this.push(out);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.remainder = Buffer.alloc(0);
    callback();
  }
}

// ---------------------------------------------------------------------------
// VoiceSessionManager
// ---------------------------------------------------------------------------
export class VoiceSessionManager extends EventEmitter {
  private readonly config: VoiceSessionConfig;
  private connection: VoiceConnection | null = null;
  private state: VoiceSessionState = "idle";
  private activeUserId: string | null = null;

  /** Per-user opus subscription cleanup handles */
  private _audioLoggedOnce = false;
  private readonly subscriptionCleanups = new Map<string, () => void>();

  constructor(config: VoiceSessionConfig) {
    super();
    this.config = config;
  }

  // ---- typed EventEmitter helpers ----------------------------------------

  override on<K extends keyof VoiceSessionEvents>(event: K, listener: VoiceSessionEvents[K]): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof VoiceSessionEvents>(
    event: K,
    ...args: Parameters<VoiceSessionEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ---- public API --------------------------------------------------------

  async joinChannel(adapterCreator: DiscordGatewayAdapterCreator): Promise<void> {
    try {
      const conn = joinVoiceChannel({
        channelId: this.config.channelId,
        guildId: this.config.guildId,
        adapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      this.connection = conn;

      // Debug: log all state transitions
      conn.on("stateChange", (oldState: VoiceConnectionState, newState: VoiceConnectionState) => {
        console.log("[VoiceConn] state:", oldState.status, "->", newState.status);
      });
      conn.on("error", (err: Error) => {
        console.error("[VoiceConn] error:", err.message);
      });

      this.setupConnectionListeners(conn);

      // Wait until the connection is ready (max 20 s)
      await entersState(conn, VoiceConnectionStatus.Ready, 20_000);
      console.log("[VoiceConn] Ready!");
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }

  leaveChannel(): void {
    this.cleanupSubscriptions();

    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // connection may already be destroyed
      }
      this.connection = null;
    }

    this.activeUserId = null;
    this.internalSetState("idle");
  }

  getState(): VoiceSessionState {
    return this.state;
  }

  /**
   * Transition the session state.  Used by external orchestrators (STT / TTS)
   * to advance the state machine through processing / speaking phases.
   */
  setState(newState: VoiceSessionState): void {
    this.validateTransition(newState);
    this.internalSetState(newState);
  }

  getActiveUserId(): string | null {
    return this.activeUserId;
  }

  getConnection(): VoiceConnection | null {
    return this.connection;
  }

  isConnected(): boolean {
    return this.connection !== null && this.connection.state.status === VoiceConnectionStatus.Ready;
  }

  // ---- connection lifecycle ----------------------------------------------

  private setupConnectionListeners(conn: VoiceConnection): void {
    conn.on(VoiceConnectionStatus.Ready, () => {
      this.setupAudioReceiver(conn);
    });

    conn.on(VoiceConnectionStatus.Disconnected, () => {
      void this.handleDisconnect(conn);
    });

    conn.on(VoiceConnectionStatus.Destroyed, () => {
      this.cleanupSubscriptions();
      this.activeUserId = null;
      this.internalSetState("idle");
    });

    // If the connection is already ready (immediate), wire up the receiver now
    if (conn.state.status === VoiceConnectionStatus.Ready) {
      this.setupAudioReceiver(conn);
    }
  }

  private async handleDisconnect(conn: VoiceConnection): Promise<void> {
    try {
      // Attempt to reconnect within 5 s
      await entersState(conn, VoiceConnectionStatus.Ready, 5_000);
    } catch {
      // Reconnect failed — destroy and rejoin is left to the caller
      try {
        conn.destroy();
      } catch {
        // already destroyed
      }
      this.connection = null;
      this.activeUserId = null;
      this.internalSetState("idle");
      this.emit("error", new Error("Voice connection lost and could not reconnect"));
    }
  }

  // ---- audio receive pipeline --------------------------------------------

  private setupAudioReceiver(conn: VoiceConnection): void {
    const receiver = conn.receiver;

    console.log("[VoiceSession] setupAudioReceiver: waiting for speaking events");

    receiver.speaking.on("start", (userId: string) => {
      console.log("[VoiceSession] speaking.start", { userId, botUserId: this.config.botUserId });
      // Ignore audio from the bot itself
      if (userId === this.config.botUserId) {
        return;
      }

      // 1:1 enforcement — lock to first speaker
      if (this.activeUserId === null) {
        this.activeUserId = userId;
        this.emit("userJoined", userId);
      }

      if (userId !== this.activeUserId) {
        return;
      }

      // Transition to listening if idle
      if (this.state === "idle") {
        this.internalSetState("listening");
      }

      // Only subscribe once per user
      if (this.subscriptionCleanups.has(userId)) {
        return;
      }

      this.subscribeToUser(conn, userId);
    });

    receiver.speaking.on("end", (userId: string) => {
      if (userId === this.config.botUserId) {
        return;
      }

      // If the active user stops speaking we keep the subscription alive;
      // the STT module decides when an utterance truly ends.
    });
  }

  private subscribeToUser(conn: VoiceConnection, userId: string): void {
    try {
      const opusStream = conn.receiver.subscribe(userId, {
        end: { behavior: 1 /* EndBehaviorType.AfterInactivity */, duration: 1000 },
      });

      const decoder = new prism.opus.Decoder({
        rate: 48000,
        channels: 2,
        frameSize: 960,
      });

      const downsampler = new PcmDownsampleTransform();

      let opusChunks = 0;
      let decoderChunks = 0;
      opusStream.on("data", () => {
        opusChunks++;
        if (opusChunks === 1 || opusChunks % 200 === 0) {
          console.log("[VoiceSession] opusStream data", { opusChunks });
        }
      });
      decoder.on("data", (buf: Buffer) => {
        decoderChunks++;
        if (decoderChunks === 1) {
          let maxAmp = 0;
          for (let i = 0; i < buf.length - 1; i += 2) {
            const s = Math.abs(buf.readInt16LE(i));
            if (s > maxAmp) {
              maxAmp = s;
            }
          }
          console.log("[VoiceSession] decoder first chunk", { bytes: buf.length, maxAmp });
        }
      });
      opusStream.pipe(decoder).pipe(downsampler);

      downsampler.on("data", (pcm: Buffer) => {
        if (!this._audioLoggedOnce) {
          console.log("[VoiceSession] first audioData chunk", { userId, bytes: pcm.length });
          this._audioLoggedOnce = true;
        }
        this.emit("audioData", pcm, userId);
      });

      const cleanup = (): void => {
        try {
          opusStream.destroy();
          decoder.destroy();
          downsampler.destroy();
        } catch {
          // streams may already be destroyed
        }
        this.subscriptionCleanups.delete(userId);
      };

      opusStream.on("close", cleanup);
      opusStream.on("error", (err: Error) => {
        this.emit("error", err);
        cleanup();
      });
      decoder.on("error", (err: Error) => {
        this.emit("error", err);
      });
      downsampler.on("error", (err: Error) => {
        this.emit("error", err);
      });

      this.subscriptionCleanups.set(userId, cleanup);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit("error", error);
    }
  }

  // ---- state machine -----------------------------------------------------

  private validateTransition(newState: VoiceSessionState): void {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(newState)) {
      throw new Error(`Invalid state transition: ${this.state} -> ${newState}`);
    }
  }

  private internalSetState(newState: VoiceSessionState): void {
    if (newState === this.state) {
      return;
    }
    const from = this.state;
    this.state = newState;
    this.emit("stateChanged", from, newState);
  }

  // ---- cleanup -----------------------------------------------------------

  private cleanupSubscriptions(): void {
    this.subscriptionCleanups.forEach((cleanup) => {
      cleanup();
    });
    this.subscriptionCleanups.clear();
  }
}
