import { describe, test, expect } from "bun:test";
import {
  applyFinalizationEvent,
  type SessionFinalizationEntry,
} from "./finalization-state.js";

describe("applyFinalizationEvent", () => {
  const now = 1_000_000;

  test("none → closing", () => {
    const result = applyFinalizationEvent(null, {
      type: "closing",
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      updatedAt: now,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "closing",
      updatedAt: now,
    });
  });

  test("closing → finalizing", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "closing",
      updatedAt: now,
      jobId: "job-1",
    };
    const result = applyFinalizationEvent(current, {
      type: "finalizing",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 1,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "finalizing",
      updatedAt: now + 1,
      jobId: "job-1",
    });
  });

  test("finalizing → ended on complete", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "finalizing",
      updatedAt: now,
      jobId: "job-1",
    };
    const result = applyFinalizationEvent(current, {
      type: "ended",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 2,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "ended",
      updatedAt: now + 2,
      jobId: "job-1",
    });
  });

  test("finalizing → detached on timeout", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "finalizing",
      updatedAt: now,
      jobId: "job-1",
    };
    const result = applyFinalizationEvent(current, {
      type: "detached_finalization",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 3,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "detached_finalization",
      updatedAt: now + 3,
      jobId: "job-1",
    });
  });

  test("detached → ended on service complete", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "detached_finalization",
      updatedAt: now,
      jobId: "job-1",
    };
    const result = applyFinalizationEvent(current, {
      type: "ended",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 4,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "ended",
      updatedAt: now + 4,
      jobId: "job-1",
    });
  });

  test("detached → ended on service failed", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "detached_finalization",
      updatedAt: now,
      jobId: "job-1",
    };
    const result = applyFinalizationEvent(current, {
      type: "ended",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 5,
    });
    expect(result).toEqual({
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "ended",
      updatedAt: now + 5,
      jobId: "job-1",
    });
  });

  test("returns null when service disconnects/cancels without persisting", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "closing",
      updatedAt: now,
    };
    const result = applyFinalizationEvent(current, {
      type: "ended",
      serviceId: "svc-a",
      sessionId: "sess-1",
      updatedAt: now + 6,
    });
    expect(result).toBeNull();
  });

  test("entries are keyed by serviceId + sessionId", () => {
    const entry1 = applyFinalizationEvent(null, {
      type: "closing",
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "first",
      updatedAt: now,
    });
    const entry2 = applyFinalizationEvent(null, {
      type: "closing",
      serviceId: "svc-b",
      sessionId: "sess-2",
      label: "second",
      updatedAt: now,
    });

    expect(entry1).not.toBeNull();
    expect(entry2).not.toBeNull();
    expect(entry1!.serviceId).toBe("svc-a");
    expect(entry1!.sessionId).toBe("sess-1");
    expect(entry2!.serviceId).toBe("svc-b");
    expect(entry2!.sessionId).toBe("sess-2");
  });

  test("returns current unchanged for mismatched serviceId/sessionId", () => {
    const current: SessionFinalizationEntry = {
      serviceId: "svc-a",
      sessionId: "sess-1",
      label: "finalize me",
      status: "closing",
      updatedAt: now,
    };
    const result = applyFinalizationEvent(current, {
      type: "finalizing",
      serviceId: "svc-b",
      sessionId: "sess-2",
      updatedAt: now + 1,
    });
    expect(result).toBe(current);
  });
});
