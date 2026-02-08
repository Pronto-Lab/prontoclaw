import { EventEmitter } from "node:events";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock all transitive dependencies before importing InterruptHandler
// ---------------------------------------------------------------------------

vi.mock("@discordjs/voice", () => ({
  joinVoiceChannel: vi.fn(),
  VoiceConnectionStatus: {
    Ready: "ready",
    Disconnected: "disconnected",
    Destroyed: "destroyed",
  },
  entersState: vi.fn(),
}));
vi.mock("prism-media", () => ({
  default: { opus: { Decoder: vi.fn() } },
  opus: { Decoder: vi.fn() },
}));
vi.mock("../../../auto-reply/dispatch.js", () => ({
  dispatchInboundMessage: vi.fn(),
}));
vi.mock("../../../auto-reply/reply/reply-dispatcher.js", () => ({
  createReplyDispatcher: vi.fn(() => ({
    waitForIdle: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { InterruptHandler } from "../interrupt-handler.js";

// ---------------------------------------------------------------------------
// Mock helpers — create EventEmitter-based stubs for each dependency
// ---------------------------------------------------------------------------

interface MockVoiceSession extends EventEmitter {
  getState: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
}

interface MockTTS extends EventEmitter {
  stop: ReturnType<typeof vi.fn>;
  getPlayedText: ReturnType<typeof vi.fn>;
}

interface MockBridge extends EventEmitter {
  abort: ReturnType<typeof vi.fn>;
}

interface MockSTT extends EventEmitter {
  // STT is passed but not directly used by InterruptHandler
}

function createMockVoiceSession(): MockVoiceSession {
  const mock = new EventEmitter() as MockVoiceSession;
  mock.getState = vi.fn().mockReturnValue("speaking");
  mock.setState = vi.fn();
  return mock;
}

function createMockTTS(): MockTTS {
  const mock = new EventEmitter() as MockTTS;
  mock.stop = vi.fn();
  mock.getPlayedText = vi.fn().mockReturnValue("played text");
  return mock;
}

function createMockBridge(): MockBridge {
  const mock = new EventEmitter() as MockBridge;
  mock.abort = vi.fn();
  return mock;
}

function createMockSTT(): MockSTT {
  return new EventEmitter() as MockSTT;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InterruptHandler timing logic", () => {
  let handler: InterruptHandler;
  let voiceSession: MockVoiceSession;
  let tts: MockTTS;
  let bridge: MockBridge;
  let stt: MockSTT;

  beforeEach(() => {
    vi.useFakeTimers();

    voiceSession = createMockVoiceSession();
    tts = createMockTTS();
    bridge = createMockBridge();
    stt = createMockSTT();

    handler = new InterruptHandler({
      voiceSession: voiceSession as never,
      tts: tts as never,
      bridge: bridge as never,
      stt: stt as never,
      interruptThresholdMs: 300,
      cooldownMs: 500,
    });

    handler.start();
  });

  afterEach(() => {
    handler.stop();
    vi.useRealTimers();
  });

  // -- 300ms threshold tests ------------------------------------------------

  describe("300ms interrupt threshold", () => {
    it("does NOT trigger interrupt for audio shorter than 300ms", () => {
      // Simulate user audio arriving while bot is speaking
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");

      // Advance time but NOT past threshold
      vi.advanceTimersByTime(200);

      // Cancel the pending interrupt by changing state away from speaking
      voiceSession.getState.mockReturnValue("idle");
      voiceSession.emit("stateChanged", "speaking", "idle");

      expect(tts.stop).not.toHaveBeenCalled();
      expect(bridge.abort).not.toHaveBeenCalled();
    });

    it("DOES trigger interrupt for audio longer than 300ms", () => {
      // Simulate user audio arriving while bot is speaking
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");

      // Advance time past threshold
      vi.advanceTimersByTime(300);

      expect(tts.stop).toHaveBeenCalledTimes(1);
      expect(bridge.abort).toHaveBeenCalledTimes(1);
      expect(voiceSession.setState).toHaveBeenCalledWith("listening");
    });

    it("emits interrupted event with played text", () => {
      const spy = vi.fn();
      handler.on("interrupted", spy);

      tts.getPlayedText.mockReturnValue("previously spoken words");

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({
        playedText: "previously spoken words",
      });
    });
  });

  // -- 500ms cooldown tests -------------------------------------------------

  describe("500ms cooldown", () => {
    it("ignores second interrupt during cooldown period", () => {
      // First interrupt
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);
      expect(tts.stop).toHaveBeenCalledTimes(1);

      // Reset state to speaking for second interrupt attempt
      voiceSession.getState.mockReturnValue("speaking");

      // Second audio arrives during cooldown (within 500ms)
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);

      // Should NOT have triggered again
      expect(tts.stop).toHaveBeenCalledTimes(1);
    });

    it("allows interrupt after cooldown expires", () => {
      // First interrupt
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);
      expect(tts.stop).toHaveBeenCalledTimes(1);

      // Wait for cooldown to expire (500ms)
      vi.advanceTimersByTime(500);

      // Reset state to speaking
      voiceSession.getState.mockReturnValue("speaking");

      // Second audio after cooldown
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);

      expect(tts.stop).toHaveBeenCalledTimes(2);
    });
  });

  // -- state change cancellation --------------------------------------------

  describe("state change cancellation", () => {
    it("cancels pending interrupt when state leaves speaking", () => {
      const cancelSpy = vi.fn();
      handler.on("interruptCancelled", cancelSpy);

      // Start audio detection
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");

      // Before threshold is reached, state changes away from speaking
      vi.advanceTimersByTime(150);
      voiceSession.getState.mockReturnValue("idle");
      voiceSession.emit("stateChanged", "speaking", "idle");

      // Advance past the original threshold
      vi.advanceTimersByTime(200);

      expect(tts.stop).not.toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    });

    it("does NOT execute interrupt if state changed during debounce", () => {
      // Audio arrives while speaking
      voiceSession.emit("audioData", Buffer.alloc(160), "user1");

      // State changes to idle during the 300ms debounce window
      vi.advanceTimersByTime(100);
      voiceSession.getState.mockReturnValue("idle");
      voiceSession.emit("stateChanged", "speaking", "idle");

      // Advance past threshold
      vi.advanceTimersByTime(300);

      // Interrupt should not have executed
      expect(tts.stop).not.toHaveBeenCalled();
      expect(bridge.abort).not.toHaveBeenCalled();
    });
  });

  // -- ignores audio when not speaking --------------------------------------

  describe("audio in non-speaking state", () => {
    it("ignores audio when not in speaking state", () => {
      voiceSession.getState.mockReturnValue("idle");

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(500);

      expect(tts.stop).not.toHaveBeenCalled();
    });

    it("ignores audio when in listening state", () => {
      voiceSession.getState.mockReturnValue("listening");

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(500);

      expect(tts.stop).not.toHaveBeenCalled();
    });
  });

  // -- start/stop lifecycle -------------------------------------------------

  describe("start/stop lifecycle", () => {
    it("does not process audio after stop()", () => {
      handler.stop();

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(500);

      expect(tts.stop).not.toHaveBeenCalled();
    });

    it("start() is idempotent — calling twice does not double-subscribe", () => {
      handler.start(); // second call (first was in beforeEach)

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);

      // Should only trigger once, not twice
      expect(tts.stop).toHaveBeenCalledTimes(1);
    });
  });

  // -- interrupt sequence order ---------------------------------------------

  describe("interrupt execution order", () => {
    it("follows correct order: getPlayedText → stop TTS → abort bridge → setState", () => {
      const callOrder: string[] = [];

      tts.getPlayedText.mockImplementation(() => {
        callOrder.push("getPlayedText");
        return "text";
      });
      tts.stop.mockImplementation(() => {
        callOrder.push("tts.stop");
      });
      bridge.abort.mockImplementation(() => {
        callOrder.push("bridge.abort");
      });
      voiceSession.setState.mockImplementation(() => {
        callOrder.push("setState");
      });

      voiceSession.emit("audioData", Buffer.alloc(160), "user1");
      vi.advanceTimersByTime(300);

      expect(callOrder).toEqual(["getPlayedText", "tts.stop", "bridge.abort", "setState"]);
    });
  });
});
