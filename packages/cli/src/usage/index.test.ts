import { describe, test, expect, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
// spyOn the real module namespaces instead of mock.module — Bun's
// mock.module is process-global and leaks across test files (breaking
// schema.test.ts/scanner.test.ts when they run after this file). spyOn
// is per-process but mockRestore() reliably restores the real exports.
import * as schema from "./schema.js";
import * as scanner from "./scanner.js";
import * as aggregator from "./aggregator.js";

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

const openUsageDbSpy = spyOn(schema, "openUsageDb").mockImplementation(mockOpenUsageDb);
const scanSessionsSpy = spyOn(scanner, "scanSessions").mockImplementation(mockScanSessions);
const getUsageDataSpy = spyOn(aggregator, "getUsageData").mockImplementation(mockGetUsageData as unknown as typeof aggregator.getUsageData);
// Preserve real @pizzapi/tools exports so other test files (e.g. remote-payload-cap)
// that import log.warn etc. don't break when running in the same process.
import * as realTools from "@pizzapi/tools";
mock.module("@pizzapi/tools", () => ({
  ...realTools,
  createLogger: () => ({
    error: mock(),
    info: mock(),
    debug: mock(),
    warn: mock(),
  }),
}));

// Dynamic import after spying to prevent hoisting issues
const { triggerScan, initUsage, closeUsage, getData } = await import("./index.js");

// Top-level afterAll so mocks are restored after ALL describe blocks finish.
// Nesting afterAll inside a describe block only restores after that block.
afterAll(() => {
  mock.restore();
  openUsageDbSpy.mockRestore();
  scanSessionsSpy.mockRestore();
  getUsageDataSpy.mockRestore();
});

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
