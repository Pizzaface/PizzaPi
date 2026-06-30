import { describe, it, expect, mock, beforeEach } from "bun:test";

const closeMock = mock(() => {});

mock.module("@pizzapi/tools", () => ({
  createLogger: mock(() => ({
    error: mock(() => {}),
    info: mock(() => {}),
    warn: mock(() => {}),
    debug: mock(() => {}),
  })),
}));

mock.module("./schema.js", () => ({
  openUsageDb: mock(() => ({
    close: closeMock,
  })),
}));

mock.module("./scanner.js", () => ({
  scanSessions: mock(() => Promise.resolve()),
}));

mock.module("./aggregator.js", () => ({
  getUsageData: mock(() => ({ mockData: true })),
}));

// Import after mocking
import { initUsage, closeUsage, getData } from "./index.js";

describe("closeUsage", () => {
  beforeEach(() => {
    closeMock.mockClear();
    closeUsage(); // ensure starting fresh
  });

  it("closes the database and sets db to null", () => {
    // Initialize so db is not null
    initUsage();

    // getData should return mock data since db is initialized
    expect(getData()).toEqual({ mockData: true } as any);

    // Call closeUsage
    closeUsage();

    // Verify close was called
    expect(closeMock).toHaveBeenCalledTimes(1);

    // Verify db was set to null because getData returns null when db is null
    expect(getData()).toBeNull();
  });

  it("does not throw if db is already null", () => {
    closeUsage(); // make sure it is null
    expect(() => closeUsage()).not.toThrow();
    expect(closeMock).not.toHaveBeenCalled();
  });
});
