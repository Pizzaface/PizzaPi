import { describe, test, expect } from "bun:test";
import { getSessionVisualState } from "./session-visual-state";

describe("getSessionVisualState", () => {
  test("returns 'active' when session is active and not awaiting", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("active");
  });

  test("returns 'awaiting' when session has pending question", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("awaiting");
  });

  test("awaiting wins over active (priority)", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("awaiting");
  });

  test("returns 'completedUnread' for completed unread session", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: true,
      isSelected: false,
    })).toBe("completedUnread");
  });

  test("returns 'idle' when none of the above", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: false,
    })).toBe("idle");
  });

  test("returns 'selectedActive' when isSelected and isActive are both true", () => {
    expect(getSessionVisualState({
      isActive: true,
      isAwaiting: true,
      isCompletedUnread: true,
      isSelected: true,
    })).toBe("selectedActive");
  });

  test("returns 'active' when compacting but not heartbeat-active", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: false,
      isCompacting: true,
    })).toBe("active");
  });

  test("returns 'selectedActive' when selected and compacting", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: false,
      isCompletedUnread: false,
      isSelected: true,
      isCompacting: true,
    })).toBe("selectedActive");
  });

  test("awaiting still wins over compacting", () => {
    expect(getSessionVisualState({
      isActive: false,
      isAwaiting: true,
      isCompletedUnread: false,
      isSelected: false,
      isCompacting: true,
    })).toBe("awaiting");
  });
});
