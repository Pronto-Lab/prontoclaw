import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock heavy transitive dependencies so the module can load in isolation.
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

import { VoiceSessionManager } from "../voice-session.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSession(): VoiceSessionManager {
  return new VoiceSessionManager({
    guildId: "g1",
    channelId: "c1",
    botUserId: "bot1",
    cfg: {} as never,
    deepgramApiKey: "key",
    sessionKey: "sk",
  });
}

// ---------------------------------------------------------------------------
// State machine tests
// ---------------------------------------------------------------------------

describe("VoiceSessionManager state machine", () => {
  let session: VoiceSessionManager;

  beforeEach(() => {
    session = createSession();
  });

  // -- valid transitions --------------------------------------------------

  describe("valid transitions", () => {
    it("idle → listening", () => {
      session.setState("listening");
      expect(session.getState()).toBe("listening");
    });

    it("listening → processing", () => {
      session.setState("listening");
      session.setState("processing");
      expect(session.getState()).toBe("processing");
    });

    it("processing → speaking", () => {
      session.setState("listening");
      session.setState("processing");
      session.setState("speaking");
      expect(session.getState()).toBe("speaking");
    });

    it("speaking → idle", () => {
      session.setState("listening");
      session.setState("processing");
      session.setState("speaking");
      session.setState("idle");
      expect(session.getState()).toBe("idle");
    });

    it("speaking → listening (barge-in)", () => {
      session.setState("listening");
      session.setState("processing");
      session.setState("speaking");
      session.setState("listening");
      expect(session.getState()).toBe("listening");
    });

    it("listening → idle (cancel)", () => {
      session.setState("listening");
      session.setState("idle");
      expect(session.getState()).toBe("idle");
    });

    it("processing → idle (abort)", () => {
      session.setState("listening");
      session.setState("processing");
      session.setState("idle");
      expect(session.getState()).toBe("idle");
    });
  });

  // -- invalid transitions ------------------------------------------------

  describe("invalid transitions", () => {
    it("idle → speaking throws", () => {
      expect(() => session.setState("speaking")).toThrow(
        "Invalid state transition: idle -> speaking",
      );
      expect(session.getState()).toBe("idle");
    });

    it("idle → processing throws", () => {
      expect(() => session.setState("processing")).toThrow(
        "Invalid state transition: idle -> processing",
      );
      expect(session.getState()).toBe("idle");
    });

    it("listening → speaking throws (must go through processing)", () => {
      session.setState("listening");
      expect(() => session.setState("speaking")).toThrow(
        "Invalid state transition: listening -> speaking",
      );
      expect(session.getState()).toBe("listening");
    });

    it("processing → listening throws", () => {
      session.setState("listening");
      session.setState("processing");
      expect(() => session.setState("listening")).toThrow(
        "Invalid state transition: processing -> listening",
      );
      expect(session.getState()).toBe("processing");
    });
  });

  // -- stateChanged event -------------------------------------------------

  describe("stateChanged event", () => {
    it("emits stateChanged on valid transition", () => {
      const spy = vi.fn();
      session.on("stateChanged", spy);

      session.setState("listening");

      expect(spy).toHaveBeenCalledWith("idle", "listening");
    });

    it("does not emit stateChanged on invalid transition", () => {
      const spy = vi.fn();
      session.on("stateChanged", spy);

      expect(() => session.setState("speaking")).toThrow();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -- initial state ------------------------------------------------------

  it("starts in idle state", () => {
    expect(session.getState()).toBe("idle");
  });

  // -- full cycle ---------------------------------------------------------

  it("completes a full conversation cycle", () => {
    const spy = vi.fn();
    session.on("stateChanged", spy);

    session.setState("listening");
    session.setState("processing");
    session.setState("speaking");
    session.setState("idle");

    expect(spy).toHaveBeenCalledTimes(4);
    expect(session.getState()).toBe("idle");
  });

  // -- disconnect resets to idle ------------------------------------------

  it("leaveChannel resets state to idle from any state", () => {
    session.setState("listening");
    session.setState("processing");
    session.setState("speaking");

    session.leaveChannel();

    expect(session.getState()).toBe("idle");
  });
});
