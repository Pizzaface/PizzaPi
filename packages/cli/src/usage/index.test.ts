import { describe, test, expect, mock, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";

// Mock dependencies
const mockCloseFn = mock(() => {});
const mockOpenUsageDb = mock(() => ({ close: mockCloseFn } as unknown as Database));

// Control scanSessions promise to test concurrency
let resolveScan: () => void;
let scanPromise: Promise<void> | null = null;
const mockScanSessions = mock(() => {
  scanPromise = new Promise((resolve) => {
    resolveScan = resolve;
  });
  return scanPromise;
});

const mockGetUsageData = mock(() => ({ mockData: true }));

mock.module("./schema.js", () => ({ openUsageDb: mockOpenUsageDb }));
// ponytail: mock.module for local modules leaks across test files in Bun 1.3.10.
// scanner.test.ts must run in a separate worker. If Bun fixes mock isolation,
// remove this comment and add mock.restore() in afterAll.
mock.module("./scanner.js", () => ({ scanSessions: mockScanSessions }));
mock.module("./aggregator.js", () => ({ getUsageData: mockGetUsageData }));
mock.module("@pizzapi/tools", () => ({
  createLogger: () => ({
    error: mock(),
    info: mock(),
    debug: mock(),
  }),
}));

// Dynamic import after mocking to prevent hoisting issues
const { triggerScan, initUsage, closeUsage, getData } = await import("./index.js");

describe("triggerScan", () => {
  beforeEach(() => {
    // Reset mocks
    mockOpenUsageDb.mockClear();
    mockScanSessions.mockClear();
    mockGetUsageData.mockClear();
    scanPromise = null;
  });

  afterEach(async () => {
    await closeUsage();
  });

  afterAll(() => {
    mock.restore();
  });

  test("noop when db is null", async () => {
    await triggerScan();
    expect(mockScanSessions).not.toHaveBeenCalled();
  });

  test("noop when already scanning", async () => {
    initUsage();
    // Wait for the background scan initiated by initUsage to start
    await Promise.resolve();

    // The initial scan triggered by initUsage() is currently running
    expect(mockScanSessions).toHaveBeenCalledTimes(1);

    // Call triggerScan concurrently
    const scan2 = triggerScan();

    // It should immediately return without starting a new scan
    expect(mockScanSessions).toHaveBeenCalledTimes(1);

    // Resolve the first scan to clean up
    resolveScan();
    await scanPromise;
    await scan2;
  });

  test("successful scan updates lastScanAt", async () => {
    initUsage();
    await Promise.resolve(); // wait for background scan
    resolveScan();
    await scanPromise;
    mockScanSessions.mockClear();

    // Set Date.now to a fixed time
    const originalDateNow = Date.now;
    let mockTime = 100000;
    global.Date.now = () => mockTime;

    try {
      // First explicit scan
      const scan1 = triggerScan();
      resolveScan();
      await scan1;
      expect(mockScanSessions).toHaveBeenCalledTimes(1);

      mockScanSessions.mockClear();

      // getData should NOT trigger scan if staleness <= 60_000
      mockTime = 100000 + 30_000; // 30s later
      getData();
      expect(mockScanSessions).not.toHaveBeenCalled();

      // getData SHOULD trigger scan if staleness > 60_000
      mockTime = 100000 + 61_000; // 61s later
      getData();
      expect(mockScanSessions).toHaveBeenCalledTimes(1);
      resolveScan();
    } finally {
      global.Date.now = originalDateNow;
    }
  });

  test("scan failure resets scanning=false", async () => {
    initUsage();
    await Promise.resolve(); // wait for background scan
    resolveScan();
    await scanPromise;
    mockScanSessions.mockClear();

    // Make the next scan fail
    const error = new Error("Scan failed");
    mockScanSessions.mockImplementationOnce(() => Promise.reject(error));

    // Call triggerScan, it should reject but reset the scanning flag
    await expect(triggerScan()).rejects.toThrow("Scan failed");

    // The next scan should be able to run
    mockScanSessions.mockImplementationOnce(() => {
      scanPromise = new Promise((resolve) => {
        resolveScan = resolve;
      });
      return scanPromise;
    });

    const nextScan = triggerScan();
    expect(mockScanSessions).toHaveBeenCalledTimes(2); // First failed, second succeeded starting
    resolveScan();
    await nextScan;
  });
});

describe("closeUsage", () => {
  beforeEach(async () => {
    mockCloseFn.mockClear();
    mockScanSessions.mockClear();
    scanPromise = null;
    await closeUsage(); // ensure starting fresh (also resets lastScanAt/scanning)
  });

  test("closes the database and sets db to null", async () => {
    // Initialize so db is not null. initUsage kicks off a background scan
    // (controlled by the module-level resolveScan handle) — drive it to
    // completion before continuing so the in-flight promise can't leak
    // module state (`scanning`, `lastScanAt`) into the next test.
    const initPromise = initUsage();
    await Promise.resolve(); // let triggerScan start and assign scanPromise
    resolveScan();
    await scanPromise;
    await initPromise;

    // getData should return mock data since db is initialized
    expect(getData()).toEqual({ mockData: true } as any);

    // Call closeUsage
    await closeUsage();

    // Verify close was called
    expect(mockCloseFn).toHaveBeenCalledTimes(1);

    // Verify db was set to null because getData returns null when db is null
    expect(getData()).toBeNull();
  });

  test("does not throw if db is already null", async () => {
    await closeUsage(); // make sure it is null
    await expect(closeUsage()).resolves.toBeUndefined();
    expect(mockCloseFn).not.toHaveBeenCalled();
  });
});
