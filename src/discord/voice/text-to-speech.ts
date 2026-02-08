import {
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  StreamType,
  type AudioPlayer,
  type VoiceConnection,
  type PlayerSubscription,
} from "@discordjs/voice";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { OpenClawConfig } from "../../config/config.js";
import { textToSpeechTelephony, type TtsTelephonyResult } from "../../tts/tts.js";

/** Target sample rate expected by Discord voice (48 kHz stereo s16le). */
const DISCORD_SAMPLE_RATE = 48_000;
const DISCORD_CHANNELS = 2;
const BYTES_PER_SAMPLE = 2; // s16le

export interface TextToSpeechOptions {
  cfg: OpenClawConfig;
  connection: VoiceConnection;
}

export interface TextToSpeechEvents {
  speakingStart: [];
  speakingEnd: [];
  sentenceComplete: [sentence: string];
  error: [error: Error];
}

export class TextToSpeech extends EventEmitter<TextToSpeechEvents> {
  private readonly cfg: OpenClawConfig;
  private readonly player: AudioPlayer;
  private readonly subscription: PlayerSubscription | undefined;

  private queue: string[] = [];
  private isProcessing = false;
  private stopped = false;
  private currentSentenceIndex = 0;
  private playedSentences: string[] = [];

  constructor({ cfg, connection }: TextToSpeechOptions) {
    super();
    this.cfg = cfg;
    this.player = createAudioPlayer();
    this.subscription = connection.subscribe(this.player);

    this.player.on("error", (err) => {
      this.emit("error", err);
    });
  }

  // ── public API ─────────────────────────────────────────────

  /** Enqueue a sentence for TTS playback. */
  speak(text: string): void {
    if (!text.trim()) {
      return;
    }
    this.queue.push(text);
    if (!this.isProcessing) {
      void this.processQueue();
    }
  }

  /** Force-stop current playback and clear the queue. */
  stop(): void {
    this.stopped = true;
    this.queue.length = 0;
    this.player.stop(true);
  }

  /** Text that was actually played through the speaker (for barge-in). */
  getPlayedText(): string {
    return this.playedSentences.join(" ");
  }

  /** Whether the AudioPlayer is currently outputting audio. */
  isPlaying(): boolean {
    return this.player.state.status === AudioPlayerStatus.Playing;
  }

  /** Clean up resources. */
  destroy(): void {
    this.stop();
    this.subscription?.unsubscribe();
    this.player.stop(true);
  }

  // ── internals ──────────────────────────────────────────────

  private async processQueue(): Promise<void> {
    if (this.isProcessing) {
      return;
    }
    this.isProcessing = true;
    this.stopped = false;

    let isFirstSentence = true;

    while (this.queue.length > 0 && !this.stopped) {
      const sentence = this.queue.shift()!;

      try {
        console.log("[TTS] calling textToSpeechTelephony", { sentence: sentence.slice(0, 60) });
        const result: TtsTelephonyResult = await textToSpeechTelephony({
          text: sentence,
          cfg: this.cfg,
        });
        console.log("[TTS] textToSpeechTelephony result", {
          success: result.success,
          provider: result.provider,
          sampleRate: result.sampleRate,
          bufferSize: result.audioBuffer?.length,
          error: result.error,
        });

        if (this.stopped) {
          break;
        }

        if (!result.success || !result.audioBuffer) {
          this.emit("error", new Error(result.error ?? "TTS returned no audio buffer"));
          continue;
        }

        const inputSampleRate = result.sampleRate ?? 22_050;
        const pcm48kStereo = upsampleAndStereo(result.audioBuffer, inputSampleRate);

        const stream = Readable.from(pcm48kStereo);
        const resource = createAudioResource(stream, {
          inputType: StreamType.Raw,
          inlineVolume: false,
        });

        if (isFirstSentence) {
          this.emit("speakingStart");
          isFirstSentence = false;
        }

        this.player.play(resource);

        await waitForPlayerIdle(this.player);

        if (this.stopped) {
          break;
        }

        this.playedSentences.push(sentence);
        this.currentSentenceIndex++;
        this.emit("sentenceComplete", sentence);
      } catch (err) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.isProcessing = false;

    if (!this.stopped) {
      this.emit("speakingEnd");
    }
  }
}

// ── helpers ────────────────────────────────────────────────

/**
 * Resample mono s16le PCM from {@link inputRate} to 48 kHz and duplicate
 * each sample into stereo (L+R), producing s16le 48 kHz 2-ch output that
 * Discord's Raw stream type expects.
 */
function upsampleAndStereo(buffer: Buffer, inputRate: number): Buffer {
  const inputSamples = buffer.length / BYTES_PER_SAMPLE;
  const ratio = DISCORD_SAMPLE_RATE / inputRate;
  const outputSamples = Math.floor(inputSamples * ratio);

  // stereo = 2 channels, each sample is 2 bytes
  const out = Buffer.alloc(outputSamples * DISCORD_CHANNELS * BYTES_PER_SAMPLE);

  for (let i = 0; i < outputSamples; i++) {
    // position in the source waveform (fractional)
    const srcPos = i / ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    // read current (and optionally next) sample for linear interpolation
    const s0 = buffer.readInt16LE(srcIdx * BYTES_PER_SAMPLE);
    const s1 = srcIdx + 1 < inputSamples ? buffer.readInt16LE((srcIdx + 1) * BYTES_PER_SAMPLE) : s0;

    const interpolated = Math.round(s0 + frac * (s1 - s0));
    const clamped = Math.max(-32_768, Math.min(32_767, interpolated));

    const outOffset = i * DISCORD_CHANNELS * BYTES_PER_SAMPLE;
    // Left channel
    out.writeInt16LE(clamped, outOffset);
    // Right channel (duplicate)
    out.writeInt16LE(clamped, outOffset + BYTES_PER_SAMPLE);
  }

  return out;
}

/** Returns a promise that resolves when the player transitions to Idle. */
function waitForPlayerIdle(player: AudioPlayer): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (player.state.status === AudioPlayerStatus.Idle) {
      resolve();
      return;
    }

    const onStateChange = (
      _oldState: { status: AudioPlayerStatus },
      newState: { status: AudioPlayerStatus },
    ): void => {
      if (newState.status === AudioPlayerStatus.Idle) {
        cleanup();
        resolve();
      }
    };

    const onError = (err: Error): void => {
      cleanup();
      reject(err);
    };

    const cleanup = (): void => {
      player.removeListener("stateChange", onStateChange);
      player.removeListener("error", onError);
    };

    player.on("stateChange", onStateChange);
    player.on("error", onError);
  });
}
