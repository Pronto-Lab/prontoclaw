import { createClient, LiveTranscriptionEvents, type ListenLiveClient } from "@deepgram/sdk";
import { EventEmitter } from "node:events";
import type { TranscriptEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
type SpeechToTextConfig = {
  apiKey: string;
  userId: string;
};

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 1000;
const MIN_CONFIDENCE = 0.3;
const MIN_TEXT_LENGTH = 2;

// ---------------------------------------------------------------------------
// SpeechToText — Deepgram live transcription wrapper
// ---------------------------------------------------------------------------
export class SpeechToText extends EventEmitter {
  private readonly apiKey: string;
  private readonly userId: string;
  private connection: ListenLiveClient | null = null;
  private accumulatedText = "";
  private reconnectAttempts = 0;
  private reconnecting = false;
  private stopped = false;

  constructor(config: SpeechToTextConfig) {
    super();
    this.apiKey = config.apiKey;
    this.userId = config.userId;
  }

  // ---- public API --------------------------------------------------------

  async start(): Promise<void> {
    this.stopped = false;
    this.reconnectAttempts = 0;
    await this.openConnection();
  }

  stop(): void {
    this.stopped = true;
    this.closeConnection();
    this.accumulatedText = "";
    this.reconnectAttempts = 0;
    this.reconnecting = false;
  }

  private _sendCount = 0;
  sendAudio(pcmBuffer: Buffer): void {
    this._sendCount++;
    if (this._sendCount === 1 || this._sendCount === 10 || this._sendCount % 500 === 0) {
      // Check if audio has actual content (not silence)
      let maxAmp = 0;
      for (let i = 0; i < pcmBuffer.length - 1; i += 2) {
        const sample = Math.abs(pcmBuffer.readInt16LE(i));
        if (sample > maxAmp) {
          maxAmp = sample;
        }
      }
      console.log("[SpeechToText] sendAudio", {
        count: this._sendCount,
        bytes: pcmBuffer.length,
        maxAmplitude: maxAmp,
        connected: this.connection?.isConnected(),
      });
    }
    if (this.connection && this.connection.isConnected()) {
      // Deepgram send() expects string | ArrayBufferLike | Blob.
      // Convert Node Buffer to ArrayBuffer to satisfy the type contract.
      const arrayBuffer = pcmBuffer.buffer.slice(
        pcmBuffer.byteOffset,
        pcmBuffer.byteOffset + pcmBuffer.byteLength,
      );
      this.connection.send(arrayBuffer);
    }
  }

  isConnected(): boolean {
    return this.connection !== null && this.connection.isConnected();
  }

  // ---- connection lifecycle ----------------------------------------------

  private async openConnection(): Promise<void> {
    const client = createClient(this.apiKey);

    const connection = client.listen.live({
      model: "nova-3",
      language: "ko",
      smart_format: true,
      interim_results: true,
      utterance_end_ms: 1200,
      vad_events: true,
      encoding: "linear16",
      sample_rate: 16000,
      channels: 1,
    });

    this.connection = connection;
    this.setupEventHandlers(connection);

    // Wait for the connection to open (or fail)
    await new Promise<void>((resolve, reject) => {
      const onOpen = (): void => {
        cleanup();
        resolve();
      };

      const onError = (err: unknown): void => {
        cleanup();
        const error = err instanceof Error ? err : new Error(String(err));
        reject(error);
      };

      const cleanup = (): void => {
        connection.removeListener(LiveTranscriptionEvents.Open, onOpen);
        connection.removeListener(LiveTranscriptionEvents.Error, onError);
      };

      connection.on(LiveTranscriptionEvents.Open, onOpen);
      connection.on(LiveTranscriptionEvents.Error, onError);
    });
  }

  private setupEventHandlers(connection: ListenLiveClient): void {
    connection.on(LiveTranscriptionEvents.Open, () => {
      this.reconnectAttempts = 0;
      this.reconnecting = false;
      console.log("[SpeechToText] Connected to Deepgram", { userId: this.userId });
    });

    connection.on(LiveTranscriptionEvents.Transcript, (data: unknown) => {
      this.handleTranscript(data);
    });

    connection.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.handleUtteranceEnd();
    });

    connection.on(LiveTranscriptionEvents.Error, (err: unknown) => {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[SpeechToText] Deepgram error", { userId: this.userId, error: error.message });
      this.emit("error", error);
      void this.attemptReconnect();
    });

    connection.on(LiveTranscriptionEvents.Close, () => {
      console.log("[SpeechToText] Disconnected from Deepgram", { userId: this.userId });
      void this.attemptReconnect();
    });
  }

  // ---- transcript processing ---------------------------------------------

  private handleTranscript(data: unknown): void {
    const result = data as DeepgramTranscriptResult;
    const alternative = result?.channel?.alternatives?.[0];
    const transcript = alternative?.transcript?.trim() ?? "";
    const confidence = alternative?.confidence ?? 0;
    const isFinal = result?.is_final ?? false;
    const speechFinal = result?.speech_final ?? false;

    console.log("[SpeechToText] transcript", {
      text: transcript,
      confidence,
      isFinal,
      speechFinal,
      len: transcript.length,
    });

    if (!alternative) {
      return;
    }
    if (!transcript || transcript.length < MIN_TEXT_LENGTH) {
      return;
    }
    if (confidence < MIN_CONFIDENCE) {
      return;
    }

    if (isFinal) {
      const event: TranscriptEvent = {
        text: transcript,
        isFinal: true,
        confidence,
        userId: this.userId,
      };
      this.emit("finalTranscript", event);

      // Append to accumulated buffer (space-separated)
      this.accumulatedText =
        this.accumulatedText.length > 0 ? `${this.accumulatedText} ${transcript}` : transcript;

      // speech_final signals end of a natural utterance
      if (speechFinal) {
        this.flushUtterance();
      }
    } else {
      const event: TranscriptEvent = {
        text: transcript,
        isFinal: false,
        confidence,
        userId: this.userId,
      };
      this.emit("partialTranscript", event);
    }
  }

  private handleUtteranceEnd(): void {
    // UtteranceEnd fires after a pause in speech — flush whatever we have
    this.flushUtterance();
  }

  private flushUtterance(): void {
    const text = this.accumulatedText.trim();
    console.log("[SpeechToText] flushUtterance", { text, len: text.length });
    if (text.length > 0) {
      console.log("[SpeechToText] emitting utteranceEnd", { text });
      this.emit("utteranceEnd", text, this.userId);
      this.accumulatedText = "";
    }
  }

  // ---- reconnection ------------------------------------------------------

  private async attemptReconnect(): Promise<void> {
    if (this.stopped || this.reconnecting) {
      return;
    }
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("[SpeechToText] Max reconnection attempts reached", { userId: this.userId });
      this.emit("error", new Error("Max Deepgram reconnection attempts reached"));
      return;
    }

    this.reconnecting = true;
    this.reconnectAttempts++;
    const attempt = this.reconnectAttempts;

    console.log(`[SpeechToText] Reconnecting (attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS})`, {
      userId: this.userId,
    });

    // Wait before reconnecting
    await new Promise<void>((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));

    // Guard: user may have called stop() during the delay
    if (this.stopped) {
      this.reconnecting = false;
      return;
    }

    try {
      this.closeConnection();
      await this.openConnection();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[SpeechToText] Reconnection failed", {
        userId: this.userId,
        attempt,
        error: error.message,
      });
      this.reconnecting = false;
      // Will retry on next close/error event if attempts remain
    }
  }

  private closeConnection(): void {
    if (this.connection) {
      try {
        this.connection.requestClose();
      } catch {
        // connection may already be closed
      }
      this.connection = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Deepgram transcript response shape (subset we care about)
// ---------------------------------------------------------------------------
type DeepgramTranscriptResult = {
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      confidence?: number;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
};
