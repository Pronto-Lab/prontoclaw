import { describe, it, expect, beforeEach } from "vitest";
import {
  registerSiblingBot,
  unregisterSiblingBot,
  isSiblingBot,
  listSiblingBots,
  clearSiblingBots,
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
});
