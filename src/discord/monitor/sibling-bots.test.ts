import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSiblingBot,
  unregisterSiblingBot,
  isSiblingBot,
  listSiblingBots,
  clearSiblingBots,
  getAgentIdForBot,
} from "./sibling-bots.js";

describe("sibling-bots", () => {
  beforeEach(() => {
    clearSiblingBots();
  });

  it("registers and recognises a sibling bot", () => {
    registerSiblingBot("111");
    expect(isSiblingBot("111")).toBe(true);
    expect(isSiblingBot("222")).toBe(false);
  });

  it("unregisters a sibling bot", () => {
    registerSiblingBot("111");
    unregisterSiblingBot("111");
    expect(isSiblingBot("111")).toBe(false);
  });

  it("lists all registered siblings", () => {
    registerSiblingBot("a");
    registerSiblingBot("b");
    expect(listSiblingBots().toSorted()).toEqual(["a", "b"]);
  });

  it("ignores empty strings", () => {
    registerSiblingBot("");
    expect(listSiblingBots()).toEqual([]);
  });

  it("clearSiblingBots resets state", () => {
    registerSiblingBot("x");
    clearSiblingBots();
    expect(isSiblingBot("x")).toBe(false);
    expect(listSiblingBots()).toEqual([]);
  });

  describe("getAgentIdForBot", () => {
    it("returns agentId when registered with one", () => {
      registerSiblingBot("bot-111", "eden");
      expect(getAgentIdForBot("bot-111")).toBe("eden");
    });

    it("returns undefined when registered without agentId", () => {
      registerSiblingBot("bot-222");
      expect(getAgentIdForBot("bot-222")).toBeUndefined();
    });

    it("returns undefined for unknown bot", () => {
      expect(getAgentIdForBot("unknown")).toBeUndefined();
    });

    it("maps multiple bots to different agents", () => {
      registerSiblingBot("bot-a", "eden");
      registerSiblingBot("bot-b", "seum");
      registerSiblingBot("bot-c", "ruda");
      expect(getAgentIdForBot("bot-a")).toBe("eden");
      expect(getAgentIdForBot("bot-b")).toBe("seum");
      expect(getAgentIdForBot("bot-c")).toBe("ruda");
    });

    it("clears agentId mapping on unregister", () => {
      registerSiblingBot("bot-x", "miri");
      unregisterSiblingBot("bot-x");
      expect(getAgentIdForBot("bot-x")).toBeUndefined();
    });

    it("clears agentId mapping on clearSiblingBots", () => {
      registerSiblingBot("bot-y", "yunseul");
      clearSiblingBots();
      expect(getAgentIdForBot("bot-y")).toBeUndefined();
    });
  });
});
