import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OrderSyncError,
  ORDER_SYNC_PROTOCOL_VERSION,
  ORDER_SYNC_HTTP_TIMEOUT_MS,
  ORDER_SYNC_MAX_BODY_BYTES,
  hasDataBulk,
  uploadOrderSyncDump,
  fetchOrderSyncReconciliation,
} from "../src/core/order-sync";

const settings = {
  syncBaseUrl: "http://sync.example.test",
  syncToken: "runtime-test-token",
};
const scope = { sellerId: "seller-1", shopId: "shop-1" };

function response(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    ...(headers ? { headers } : {}),
  });
}

// ─── hasDataBulk ─────────────────────────────────────────────────────

describe("hasDataBulk", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("returns covered map on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-1",
        data: {
          domain: "orders",
          covered: { "order-1": true, "order-2": false },
        },
      }),
    );
    const result = await hasDataBulk(settings, scope, "orders", ["order-1", "order-2"], { fetchImpl });
    expect(result).toEqual({
      domain: "orders",
      covered: { "order-1": true, "order-2": false },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(call[0])).toContain("v2/order-sync/has-data");
    expect(call[1].method).toBe("POST");
    const sent = JSON.parse(call[1].body as string);
    expect(sent).toEqual({
      scope: { sellerId: "seller-1", shopId: "shop-1" },
      domain: "orders",
      ids: ["order-1", "order-2"],
    });
  });

  it("结算覆盖查询携带 statement version，避免旧版本遮蔽新版本", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-statement-version",
        data: { domain: "statements", covered: { "statement-1": false } },
      }),
    );

    await hasDataBulk(settings, scope, "statements", ["statement-1"], {
      fetchImpl,
      versions: { "statement-1": 2 },
    });

    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(call[1].body as string)).toEqual({
      scope: { sellerId: "seller-1", shopId: "shop-1" },
      domain: "statements",
      ids: ["statement-1"],
      versions: { "statement-1": 2 },
    });
  });

  it("rejects a nonzero business code even when HTTP status is 200", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: 7, requestId: "req-1", data: { domain: "orders", covered: {} } }),
    );
    await expect(
      hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("rejects a response for a different order domain", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: 0, requestId: "req-1", data: { domain: "logistics", covered: {} } }),
    );
    await expect(
      hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("classifies network error as NETWORK", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("classifies timeout as NETWORK with transportFailure=timeout", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    try {
      const timedOut = expect(
        hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl }),
      ).rejects.toMatchObject({
        code: "NETWORK",
        transportFailure: "timeout",
      });
      await vi.advanceTimersByTimeAsync(ORDER_SYNC_HTTP_TIMEOUT_MS);
      await timedOut;
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("classifies caller abort as AbortError", async () => {
    const caller = new AbortController();
    const fetchImpl = vi.fn().mockImplementation(
      (_url: unknown, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        }),
    );
    const p = hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl, signal: caller.signal });
    caller.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });

  it("throws PERMANENT when sync token is empty", async () => {
    await expect(
      hasDataBulk({ ...settings, syncToken: "" }, scope, "orders", ["order-1"]),
    ).rejects.toMatchObject({ code: "PERMANENT" });
  });

  it("throws RETRYABLE on 500", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: 500, message: "internal" }, 500),
    );
    await expect(
      hasDataBulk(settings, scope, "orders", ["order-1"], { fetchImpl }),
    ).rejects.toMatchObject({ code: "RETRYABLE" });
  });
});

// ─── uploadOrderSyncDump ─────────────────────────────────────────────

describe("uploadOrderSyncDump", () => {
  const dump = {
    domain: "orders" as const,
    mainOrderId: "order-1",
    endpoint: "/api/fulfillment/order/list",
    method: "POST",
    request: { params: {}, body: {} },
    response: { status: 200, body: { code: 0, data: {} } },
    createdAt: "2026-09-08T10:00:00.000Z",
  };

  it("returns inserted status on success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-3",
        data: {
          status: "inserted",
          rowsWritten: 3,
        },
      }),
    );
    const result = await uploadOrderSyncDump(settings, scope, dump, { fetchImpl });
    // strict HTTP 语义：仅保留 requestId，不再返回 status / rowsWritten
    expect(result).toEqual({ requestId: "req-3" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const sent = JSON.parse(call[1].body as string);
    expect(sent.protocolVersion).toBe(ORDER_SYNC_PROTOCOL_VERSION);
    expect(sent.scope).toEqual(scope);
    expect(sent.dump).toEqual(dump);
  });

  it("sends the canonical createdAt field and preserves a null upstream body", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response({ code: 0, requestId: "req-empty" }));
    const emptyBodyDump = {
      ...dump,
      response: { status: 200, body: null },
    };

    await uploadOrderSyncDump(settings, scope, emptyBodyDump, { fetchImpl });

    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    const sent = JSON.parse(call[1].body as string);
    expect(sent.dump.createdAt).toBe(dump.createdAt);
    expect(sent.dump).not.toHaveProperty("capturedAt");
    expect(sent.dump.response.body).toBeNull();
  });

  it("rejects a createdAt value without a timezone before sending", async () => {
    const fetchImpl = vi.fn();
    await expect(
      uploadOrderSyncDump(settings, scope, {
        ...dump,
        createdAt: "2026-09-08T10:00:00.000",
      }, { fetchImpl }),
    ).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  // 2026-09-11 回归守卫：服务端真实响应是 {status, logId, rowsWritten}，没有 idempotencyKey。
  // strict HTTP 语义下，旧字段已删除，仅保留 requestId。
  it("accepts the real /v2/order-sync/dumps response shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-real",
        data: { status: "inserted", logId: 42, rowsWritten: 5 },
      }),
    );
    const result = await uploadOrderSyncDump(settings, scope, dump, { fetchImpl });
    // strict HTTP 语义：旧字段已删除，仅保留 requestId
    expect(result).toEqual({ requestId: "req-real" });
  });

  it("returns updated status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-4",
        data: { status: "updated" },
      }),
    );
    const result = await uploadOrderSyncDump(settings, scope, dump, { fetchImpl });
    // strict HTTP 语义：仅保留 requestId
    expect(result).toEqual({ requestId: "req-4" });
  });

  it("returns stale_ignored status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-5",
        data: { status: "stale_ignored" },
      }),
    );
    const result = await uploadOrderSyncDump(settings, scope, dump, { fetchImpl });
    // strict HTTP 语义：仅保留 requestId
    expect(result).toEqual({ requestId: "req-5" });
  });

  it("throws PERMANENT on 400", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: "BAD_REQUEST", message: "invalid" }, 400),
    );
    await expect(
      uploadOrderSyncDump(settings, scope, dump, { fetchImpl }),
    ).rejects.toMatchObject({ code: "PERMANENT", httpStatus: 400 });
  });

  it("throws PERMANENT on 413", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: "PAYLOAD_TOO_LARGE" }, 413),
    );
    await expect(
      uploadOrderSyncDump(settings, scope, dump, { fetchImpl }),
    ).rejects.toMatchObject({ code: "PERMANENT", httpStatus: 413 });
  });

  it("retries on 429 then succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(response({ code: 429, message: "rate limited" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(
        response({
          code: 0,
          requestId: "req-6",
          data: { status: "inserted" },
        }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await uploadOrderSyncDump(settings, scope, dump, { fetchImpl, sleep });
    // strict HTTP 语义：仅保留 requestId
    expect(result.requestId).toBe("req-6");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000, undefined);
  });

  it("classifies network error as NETWORK after retries", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      uploadOrderSyncDump(settings, scope, dump, { fetchImpl }),
    ).rejects.toMatchObject({
      code: "NETWORK",
      transportFailure: "network",
      requestDiagnostics: {
        endpoint: "http://sync.example.test/v2/order-sync/dumps",
        requestId: expect.any(String),
        attempts: 3,
        totalDurationMs: expect.any(Number),
        lastAttemptDurationMs: expect.any(Number),
        lastErrorName: "TypeError",
        lastErrorMessage: "Failed to fetch",
      },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("rejects protocol envelope with invalid response shape", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ wrong: true }),
    );
    await expect(
      uploadOrderSyncDump(settings, scope, dump, { fetchImpl }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
  });
});

// ─── fetchOrderSyncReconciliation ───────────────────────────────────

describe("fetchOrderSyncReconciliation", () => {
  const reconcileRequest = {
    domains: ["orders", "logistics"] as ("orders" | "logistics")[],
    orders: {
      pageSize: 20,
      sortInfo: "6",
      anchorPositions: [0, 450, 899],
      hotWindowSize: 40,
    },
    logistics: { limit: 500 },
  };

  it("returns order anchors and logistics candidates from one endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-7",
        data: {
          orders: {
            serverTotal: 900,
            anchors: [{ position: 899, orderId: "order-900" }],
            canIncremental: true,
            offsetSafe: true,
            ordering: { field: "order_time", direction: "desc", tieBreaker: "order_id" },
            hotWindowSize: 40,
          },
          logistics: {
            complete: true,
            items: [{ orderId: "order-1", isTerminal: false, terminalReason: null }],
            pendingTotal: 1,
            terminalTotal: 899,
          },
        },
      }),
    );
    const result = await fetchOrderSyncReconciliation(settings, scope, reconcileRequest, { fetchImpl });
    expect(result).toEqual({
      orders: {
        serverTotal: 900,
        anchors: [{ position: 899, orderId: "order-900" }],
        canIncremental: true,
        offsetSafe: true,
        ordering: { field: "order_time", direction: "desc", tieBreaker: "order_id" },
        hotWindowSize: 40,
      },
      logistics: {
        complete: true,
        items: [{ orderId: "order-1", isTerminal: false, terminalReason: null }],
        pendingTotal: 1,
        terminalTotal: 899,
      },
    });
    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(call[0].toString()).toContain("v2/order-sync/reconcile");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body as string)).toEqual({
      protocolVersion: ORDER_SYNC_PROTOCOL_VERSION,
      scope,
      ...reconcileRequest,
    });
  });

  it("supports the same endpoint's logistics cursor", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 0,
        requestId: "req-8",
        data: {
          logistics: {
            complete: false,
            items: [],
            nextCursor: "2",
          },
        },
      }),
    );
    await fetchOrderSyncReconciliation(settings, scope, {
      domains: ["logistics"],
      logistics: { limit: 500, cursor: "1" },
    }, { fetchImpl });
    const call = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(call[1].body as string).logistics).toEqual({ limit: 500, cursor: "1" });
  });

  it("rejects a nonzero reconcile business code", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({
        code: 7,
        requestId: "req-9",
        data: {},
      }),
    );
    await expect(
      fetchOrderSyncReconciliation(settings, scope, reconcileRequest, { fetchImpl }),
    ).rejects.toMatchObject({ code: "PROTOCOL" });
  });

  it("classifies network error as NETWORK", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      fetchOrderSyncReconciliation(settings, scope, reconcileRequest, { fetchImpl }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });

  it("throws PERMANENT on 403", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      response({ code: "FORBIDDEN", message: "no access" }, 403),
    );
    await expect(
      fetchOrderSyncReconciliation(settings, scope, reconcileRequest, { fetchImpl }),
    ).rejects.toMatchObject({ code: "PERMANENT", httpStatus: 403 });
  });
});
