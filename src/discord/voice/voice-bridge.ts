import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { MsgContext } from "../../auto-reply/templating.js";
import type { OpenClawConfig } from "../../config/config.js";
import { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

type VoiceBridgeConfig = {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  accountId?: string;
  userId: string;
  botUserId: string;
  guildId?: string;
  channelId?: string;
};

/**
 * Minimum sentence length to emit immediately. Shorter fragments are buffered
 * and merged with the next sentence to avoid choppy TTS output.
 */
const MIN_SENTENCE_LENGTH = 10;

/**
 * If the buffer has content for longer than this (ms) without a sentence
 * boundary, force-flush it so TTS doesn't stall.
 */
const FLUSH_TIMEOUT_MS = 2_000;

/**
 * Regex that splits on common sentence-ending punctuation, including Korean
 * sentence endings (다. 요. 요! 요? 죠. 까? 네. 지. 어. 아.) and standard
 * CJK full-width punctuation.
 */
const SENTENCE_BOUNDARY_RE = /([^.!?\u3002\uFF01\uFF1F]*[.!?\u3002\uFF01\uFF1F])/g;

// ---------------------------------------------------------------------------
// VoiceBridge — connects STT transcripts to OpenClaw gateway, emits text
// chunks for TTS.
// ---------------------------------------------------------------------------

export class VoiceBridge extends EventEmitter {
  private readonly cfg: OpenClawConfig;
  private readonly sessionKey: string;
  private readonly agentId: string | undefined;
  private readonly accountId: string | undefined;
  private readonly userId: string;
  private readonly guildId: string | undefined;

  private textBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private currentAbortController: AbortController | null = null;
  private processing = false;

  private readonly botUserId: string;
  private readonly channelId: string | undefined;

  constructor(config: VoiceBridgeConfig) {
    super();
    this.cfg = config.cfg;
    this.sessionKey = config.sessionKey;
    this.agentId = config.agentId;
    this.accountId = config.accountId;
    this.userId = config.userId;
    this.botUserId = config.botUserId;
    this.guildId = config.guildId;
    this.channelId = config.channelId;
  }

  // ---- public API --------------------------------------------------------

  /**
   * Send a user utterance to the OpenClaw agent and stream back sentence-level
   * text chunks via the `textChunk` event.
   */
  async sendMessage(text: string): Promise<void> {
    console.log("[VoiceBridge] sendMessage called", { text });
    const ctx: MsgContext = {
      Body: text,
      BodyForAgent: text,
      RawBody: text,
      CommandBody: text,
      BodyForCommands: text,
      SessionKey: this.sessionKey,
      Provider: "discord",
      Surface: "discord",
      OriginatingChannel: "discord",
      ChatType: "channel",
      CommandAuthorized: true,
      MessageSid: randomUUID(),
      SenderId: this.userId,
      AccountId: this.accountId,
      From: "discord:" + this.userId,
      To: "discord:" + this.botUserId,
      OriginatingTo: "discord:voice:" + (this.guildId ?? "") + ":" + (this.channelId ?? ""),
    };

    const abortController = new AbortController();
    this.currentAbortController = abortController;
    this.processing = true;

    const dispatcher = createReplyDispatcher({
      deliver: async (payload, info) => {
        console.log("[VoiceBridge] deliver called", {
          kind: info.kind,
          text: payload.text?.slice(0, 80),
        });
        if (info.kind === "final" || info.kind === "block") {
          const chunk = payload.text?.trim();
          if (chunk) {
            console.log("[VoiceBridge] processStreamingText", { chunk: chunk.slice(0, 80) });
            this.processStreamingText(chunk);
          }
        }
      },
      onError: (err) => {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      },
    });

    this.emit("responseStart");
    console.log("[VoiceBridge] calling dispatchInboundMessage");

    try {
      await dispatchInboundMessage({
        ctx,
        cfg: this.cfg,
        dispatcher,
        replyOptions: { abortSignal: abortController.signal },
      });

      // Wait for dispatcher queue to drain before flushing.
      console.log("[VoiceBridge] dispatchInboundMessage returned, waiting for idle");
      await dispatcher.waitForIdle();
      console.log("[VoiceBridge] dispatcher idle");
    } catch (err) {
      if (!abortController.signal.aborted) {
        this.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this.flushBuffer();
      this.processing = false;
      this.currentAbortController = null;
      this.emit("responseEnd");
    }
  }

  /**
   * Abort any in-flight agent response (e.g. for barge-in).
   */
  abort(): void {
    this.currentAbortController?.abort();
    this.currentAbortController = null;
    this.textBuffer = "";
    this.clearFlushTimer();
    this.processing = false;
    this.emit("responseEnd");
  }

  /**
   * Whether the bridge is currently processing a message.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  // ---- internal ----------------------------------------------------------

  /**
   * Buffer incoming text and emit sentence-level chunks for TTS. Short
   * fragments are held back and merged with the next sentence to avoid
   * choppy output.
   */
  private processStreamingText(text: string): void {
    this.textBuffer += text;
    this.clearFlushTimer();

    const sentences: string[] = [];
    let remainder = this.textBuffer;

    // Extract complete sentences.
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    const re = new RegExp(SENTENCE_BOUNDARY_RE.source, "g");
    while ((match = re.exec(remainder)) !== null) {
      lastIndex = re.lastIndex;
      const sentence = match[1].trim();
      if (sentence) {
        sentences.push(sentence);
      }
    }

    // Keep the trailing fragment (incomplete sentence) in the buffer.
    remainder = remainder.slice(lastIndex).trim();

    // Emit sentences, merging short ones with the next.
    let pending = "";
    for (const sentence of sentences) {
      pending = pending ? pending + " " + sentence : sentence;
      if (pending.length >= MIN_SENTENCE_LENGTH) {
        this.emit("textChunk", pending);
        pending = "";
      }
    }

    // Anything left goes back into the buffer.
    this.textBuffer = pending ? (remainder ? pending + " " + remainder : pending) : remainder;

    // Arm a flush timer so buffered content doesn't stall forever.
    if (this.textBuffer) {
      this.flushTimer = setTimeout(() => {
        this.flushBuffer();
      }, FLUSH_TIMEOUT_MS);
    }
  }

  /**
   * Emit any remaining buffered text and reset state.
   */
  private flushBuffer(): void {
    this.clearFlushTimer();
    const remaining = this.textBuffer.trim();
    if (remaining) {
      this.emit("textChunk", remaining);
    }
    this.textBuffer = "";
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }
}
