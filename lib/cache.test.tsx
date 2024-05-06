/* eslint-disable no-empty */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-shadow */
import { LRUCache } from "lru-cache";
import * as React from "react";
import { createRoot } from "react-dom/client";

import type { Mock } from "vitest";
import { vi } from "vitest";

import type { SuspenseCache, SuspenseResourceCache } from "./cache.js";
import { cache, cacheResource } from "./cache.js";
import { ErrorBoundary } from "./test-utils.js";
import type { CacheLoadContext } from "./types.js";
import { CacheResultStatus, CacheStatus } from "./types.js";
import { defer } from "./utils.js";
import type { Deferred } from "./utils.js";

function defaultLoad(_options: CacheLoadContext, key: string): Promise<string> {
  if (key.startsWith("error")) {
    return Promise.reject(key);
  }
  return Promise.resolve(key);
}

describe("SuspenseCache", () => {
  let suspenseCache: SuspenseCache<[string], string>;
  let load: Mock<[CacheLoadContext, string], Promise<string>>;
  let getCacheKey: Mock<[[string]], string>;

  beforeEach(() => {
    load = vi.fn();
    load.mockImplementation(defaultLoad);

    getCacheKey = vi.fn();
    getCacheKey.mockImplementation((key) => key.toString());

    suspenseCache = cache(load, {
      getKey: getCacheKey,
    });
  });

  it("should supply a working default getCacheKey if none is provided", () => {
    const suspenseCache = cache(
      async (_context, string: string, _number: number, _boolean: boolean) =>
        string
    );

    suspenseCache.set(["string", 123, true], "foo");
    suspenseCache.set(["other string", 456, false], "bar");

    expect(suspenseCache.peek("string", 123, true)).toEqual("foo");
    expect(suspenseCache.peek("other string", 456, false)).toEqual("bar");

    const resourceCache = cacheResource({
      "/1": (_context, string: string, _number: number, _boolean: boolean) =>
        string,
      "/2": (_context, string: string, _number: number, _boolean: boolean) =>
        string,
    });

    resourceCache.set(["/1", "string", 123, true], "foo");
    resourceCache.set(["/2", "other string", 456, false], "bar");

    expect(resourceCache.peek("/1", "string", 123, true)).toEqual("foo");
    expect(resourceCache.peek("/2", "other string", 456, false)).toEqual("bar");
  });

  describe("ttl", () => {
    it("should invalidate items after the specified time", async () => {
      const deferred = defer<string>();
      const suspenseCache = cache((_, _id: string) => deferred.promise, {
        getKey: getCacheKey,
        ttl: 100,
      });

      suspenseCache.set(["async"], "async");

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(suspenseCache.peek("async")).toEqual("async");

      await new Promise((resolve) => setTimeout(resolve, 100));

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
    });

    it("should always invalidate items if set to 0", async () => {
      const deferred = defer<string>();
      const suspenseCache = cache((_, _id: string) => deferred.promise, {
        getKey: getCacheKey,
        ttl: 0,
      });

      suspenseCache.set(["async"], "async");
      suspenseCache.get("async");

      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
    });

    it("should be able to get dynamic ttls", async () => {
      const deferred = defer<string>();
      const suspenseCache = cache((_, _id: string) => deferred.promise, {
        getKey: getCacheKey,
        ttl: ([key]) => (key === "async" ? 100 : undefined),
      });

      suspenseCache.set(["async"], "async");
      suspenseCache.set(["sync"], "sync");
      suspenseCache.get("async");
      suspenseCache.get("sync");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.RESOLVED);
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);
      await new Promise((resolve) => setTimeout(resolve, 125));
      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);
    });
  });

  describe("invalidate", () => {
    it("should invalidate a cache item", () => {
      let deferred = defer<string>();
      let fn = vi.fn();
      load.mockImplementation(() => {
        fn();
        return deferred.promise;
      });
      suspenseCache.set(["sync"], "sync");

      suspenseCache.invalidate("sync");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("should invalidate a pending or revalidating cache item", async () => {
      let deferred = defer<string>();
      let fn = vi.fn();
      let suspenseCache = cache((_, _key: string) => {
        fn();
        return deferred.promise;
      });

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(fn).toHaveBeenCalledTimes(1);

      suspenseCache.invalidate("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(fn).toHaveBeenCalledTimes(2);

      deferred.resolve("async");
      await suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.RESOLVED);
      expect(fn).toHaveBeenCalledTimes(2);

      suspenseCache.invalidate("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("should not cause a suspended request to throw when revalidating", async () => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      let deferred: Deferred<string>;
      const suspenseCache = cache(async () => {
        deferred = defer<string>();
        return deferred.promise;
      });

      let suspenseCount = 0;
      let renderCount = 0;
      let lastRenderedValue: string | undefined = undefined;

      function Component(): any {
        const value = suspenseCache.use();
        renderCount++;
        lastRenderedValue = value;
        return value;
      }

      function Fallback(): any {
        suspenseCount++;
        return null;
      }

      async function mount(): Promise<any> {
        const container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(
            <ErrorBoundary>
              <React.Suspense fallback={<Fallback />}>
                <Component />
              </React.Suspense>
            </ErrorBoundary>
          );
        });
      }

      await mount();
      expect(suspenseCount).toBe(1);
      expect(renderCount).toBe(0);

      await React.act(async () => {
        deferred.resolve("async");
        await deferred.promise;
      });

      expect(renderCount).toBe(1);

      await React.act(async () => {
        suspenseCache.invalidate();
      });
      expect(suspenseCount).toBe(1);
      expect(lastRenderedValue).toBe("async");

      await React.act(async () => {
        deferred.resolve("async-2");
        await deferred.promise;
      });

      expect(suspenseCount).toBe(1);
      expect(lastRenderedValue).toBe("async-2");
    });
  });

  describe("invalidateAll", () => {
    it("should invalidate all cache items", () => {
      let deferred = defer<string>();
      let fn = vi.fn();
      load.mockImplementation(() => {
        fn();
        return deferred.promise;
      });

      suspenseCache.set(["sync"], "sync");
      suspenseCache.set(["async"], "async");
      suspenseCache.set(["sync-2"], "sync-2");
      suspenseCache.set(["async-2"], "async-2");

      suspenseCache.invalidateAll();
      expect(fn).toHaveBeenCalledTimes(4);
    });
  });

  describe("invalidateMatching", () => {
    it("should invalidate cache items that match a predicate", () => {
      let deferred = defer<string>();
      let fn = vi.fn();
      load.mockImplementation(() => {
        fn();
        return deferred.promise;
      });

      suspenseCache.set(["sync"], "sync");
      suspenseCache.set(["async"], "async");
      suspenseCache.set(["sync-2"], "sync-2");
      suspenseCache.set(["async-2"], "async-2");

      suspenseCache.invalidateMatching(([key]) => key.startsWith("sync"));
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("delete", () => {
    it("should delete a cache item", () => {
      let deferred = defer<string>();

      load.mockImplementation(() => {
        return deferred.promise;
      });

      suspenseCache.set(["sync"], "sync");
      suspenseCache.delete("sync");

      expect(suspenseCache.peek("sync")).toBeUndefined();
    });
  });

  describe("deleteMatching", () => {
    it("should delete cache items that match a predicate", () => {
      let deferred = defer<string>();

      load.mockImplementation(() => {
        return deferred.promise;
      });

      suspenseCache.set(["sync"], "sync");
      suspenseCache.set(["async"], "async");
      suspenseCache.set(["sync-2"], "sync-2");
      suspenseCache.set(["async-2"], "async-2");

      suspenseCache.deleteMatching(([key]) => key.startsWith("sync"));
      expect(suspenseCache.peek("sync")).toBeUndefined();
      expect(suspenseCache.peek("sync-2")).toBeUndefined();
      expect(suspenseCache.peek("async")).toEqual("async");
      expect(suspenseCache.peek("async-2")).toEqual("async-2");
    });
  });

  describe("abort", () => {
    it("should abort an active request", () => {
      let abortSignal: AbortSignal;
      let deferred: Deferred<string>;
      load.mockImplementation(async (options, _params) => {
        abortSignal = options.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      expect(suspenseCache.abort("async")).toBe(true);
      expect(suspenseCache.getStatus("async")).toBe(undefined);

      expect(abortSignal!.aborted).toBe(true);

      deferred!.resolve("async");
      expect(suspenseCache.getStatus("async")).toBe(undefined);
    });

    it("should restart an aborted request on next fetch", async () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      const initialDeferred = deferred!;

      expect(suspenseCache.abort("async")).toBe(true);
      expect(suspenseCache.getStatus("async")).toBe(undefined);

      const fetchTwo = suspenseCache.get("async");

      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(load).toHaveBeenCalled();

      // At this point, even if the first request completes– it should be ignored.
      initialDeferred.resolve("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      // But the second request should be processed.
      deferred!.resolve("async");
      await fetchTwo;
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.RESOLVED);
    });

    it("should gracefully handle an abort request for a completed fetch", () => {
      suspenseCache.set(["sync"], "sync");
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);

      expect(suspenseCache.abort("sync")).toBe(false);
    });

    it("should set the cache item to MISSING if the abort happens while it is pending", () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });
      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      suspenseCache.abort("async");
      expect(suspenseCache.getStatus("async")).toBe(undefined);
    });

    it("should transition the cache item to resolved if the abort happens while it is revalidating", async () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.set(["async"], "async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.RESOLVED);

      suspenseCache.invalidate("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      suspenseCache.abort("async");
      expect(suspenseCache.getStatus("async")).toBe(undefined);
    });
  });

  describe("cache.set", () => {
    it("should set and return pre-fetched values without calling load again", () => {
      suspenseCache.set(["sync-1"], "SYNC");
      suspenseCache.set(["async-1"], "ASYNC");

      expect(suspenseCache.peek("sync-1")).toEqual("SYNC");
      expect(suspenseCache.peek("async-1")).toEqual("ASYNC");

      expect(load).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("should event cached items", () => {
      suspenseCache.set(["sync-1"], "VALUE 1");
      suspenseCache.set(["sync-2"], "VALUE 2");

      expect(suspenseCache.peek("sync-1")).toEqual("VALUE 1");
      expect(suspenseCache.peek("sync-2")).toEqual("VALUE 2");

      expect(load).not.toHaveBeenCalled();

      suspenseCache.delete("sync-1");

      expect(suspenseCache.peek("sync-1")).toEqual(undefined);
      expect(suspenseCache.peek("sync-2")).toEqual("VALUE 2");
    });

    it("should refetch requested items after deletion", () => {
      suspenseCache.set(["sync"], "VALUE");
      suspenseCache.delete("sync");

      expect(load).not.toHaveBeenCalled();

      suspenseCache.get("sync");

      expect(load).toHaveBeenCalled();
    });
  });

  describe("clear", () => {
    it("should clear cached items", () => {
      suspenseCache.set(["sync-1"], "VALUE 1");
      suspenseCache.set(["sync-2"], "VALUE 2");

      expect(suspenseCache.peek("sync-1")).toEqual("VALUE 1");
      expect(suspenseCache.peek("sync-2")).toEqual("VALUE 2");

      expect(load).not.toHaveBeenCalled();

      suspenseCache.clear();

      expect(suspenseCache.peek("sync-1")).toEqual(undefined);
      expect(suspenseCache.peek("sync-2")).toEqual(undefined);
    });

    it("should refetch requested items after deletion", () => {
      suspenseCache.set(["sync-1"], "VALUE 1");
      suspenseCache.set(["sync-2"], "VALUE 2");

      expect(load).not.toHaveBeenCalled();

      suspenseCache.clear();

      suspenseCache.get("sync-1");
      suspenseCache.get("sync-2");

      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe("getStatus", () => {
    it("should return not-found for keys that have not been loaded", () => {
      expect(suspenseCache.getStatus("nope")).toBe(undefined);
    });

    it("should transition from pending to resolved", async () => {
      const willResolve = suspenseCache.get("async");

      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      await willResolve;

      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.RESOLVED);
    });

    it("should transition from pending to rejected", async () => {
      let deferred: Deferred<string>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });

      const promise = suspenseCache.get("error");

      expect(suspenseCache.getStatus("error")).toBe(CacheStatus.PENDING);

      deferred!.reject({ key: "error--" });
      try {
        await promise;
      } catch {}

      expect(suspenseCache.getStatus("error")).toBe(CacheStatus.REJECTED);
    });

    it("should return resolved or rejected for keys that have already been loaded", async () => {
      const willResolve = suspenseCache.get("sync");
      await willResolve;
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);

      const willReject = suspenseCache.get("error");
      try {
        await willReject;
      } catch (error) {}
      expect(suspenseCache.getStatus("error")).toBe(CacheStatus.REJECTED);
    });
  });

  describe("get", () => {
    it("should return async values", async () => {
      const thenable = suspenseCache.get("async");

      expect(thenable).toBeInstanceOf(Promise);

      expect(await thenable).toBe("async");
    });

    it("should only load the same value once (per key)", async () => {
      expect(await suspenseCache.get("sync")).toBe("sync");
      expect(await suspenseCache.get("sync")).toBe("sync");

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe("invalidate", () => {
    it("should change the status of a cached value to revalidating if resolved", () => {
      suspenseCache.set(["async"], "async");
      suspenseCache.invalidate("async");

      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
    });

    it("should abort the current request if the value is pending or revalidating", () => {
      let signal: AbortSignal;
      let deferred: Deferred<string>;
      load.mockImplementation((ctx, _key) => {
        signal = ctx.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      const originalSignal = signal!;
      suspenseCache.invalidate("async");
      expect(originalSignal.aborted).toBe(true);
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      suspenseCache.set(["async-2"], "async-2");
      suspenseCache.invalidate("async-2");
      expect(suspenseCache.getStatus("async-2")).toBe(CacheStatus.PENDING);
      const originalSignal2 = signal!;
      suspenseCache.invalidate("async-2");
      expect(originalSignal2.aborted).toBe(true);
      expect(suspenseCache.getStatus("async-2")).toBe(CacheStatus.PENDING);
    });

    it("should not cause a suspended request to throw when revalidating", async () => {
      let deferred: Deferred<string>;
      load.mockImplementation((_ctx, _key) => {
        deferred = defer();
        return deferred.promise;
      });
      suspenseCache.set(["async"], "async");
      suspenseCache.invalidate("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.get("async")).toBeInstanceOf(Promise);
    });

    it("should cause a missing value to be preloaded", () => {
      expect(suspenseCache.getStatus("async")).toBe(undefined);
      suspenseCache.invalidate("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
    });
  });

  describe("invalidateAll", () => {
    it("should invalidate all values", () => {
      let deferred: Deferred<string>;
      load.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });
      suspenseCache.set(["async"], "async");
      suspenseCache.set(["sync"], "sync");
      suspenseCache.invalidateAll();
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus("missing")).toBe(undefined);
    });

    it("should abort all pending requests", () => {
      let signals: AbortSignal[] = [];
      let deferred: Deferred<string>;
      load.mockImplementation((ctx, _key) => {
        signals.push(ctx.signal);
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get("async");
      suspenseCache.get("async-2");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus("async-2")).toBe(CacheStatus.PENDING);
      suspenseCache.invalidateAll();
      expect(signals.slice(0, 1).every((signal) => signal.aborted)).toBe(true);
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus("async-2")).toBe(CacheStatus.PENDING);
    });
  });

  describe("peek", () => {
    it("should return undefined for values not yet loaded", () => {
      expect(suspenseCache.peek("sync")).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    });

    it("should return undefined for values that are pending", () => {
      suspenseCache.get("async");
      expect(suspenseCache.peek("async")).toBeUndefined();
    });

    it("should return a cached value for values that have resolved", () => {
      suspenseCache.set(["sync"], "sync");
      expect(suspenseCache.peek("sync")).toEqual("sync");
    });

    it("should return the last value for invalidated records", () => {
      suspenseCache.set(["async"], "async");
      suspenseCache.invalidate("async");
      expect(suspenseCache.peek("async")).toEqual("async");
    });

    it("should return a cached value for values that are overwritten", () => {
      suspenseCache.set(["sync"], "sync");
      suspenseCache.set(["sync"], "new-sync");
      expect(suspenseCache.peek("sync")).toEqual("new-sync");
    });

    it("should throw for values that have rejected", async () => {
      try {
        await suspenseCache.get("error-expected");
      } catch (error) {}
      expect(() => suspenseCache.peek("error-expected")).toThrow();
    });
  });

  describe("preload", () => {
    it("should start fetching a resource", async () => {
      suspenseCache.preload("sync-1");

      load.mockReset();

      // Verify value already loaded
      suspenseCache.set(["sync-1"], "sync-1");
      suspenseCache.get("sync-1");
      expect(load).not.toHaveBeenCalled();
      expect(suspenseCache.peek("sync-1")).toEqual("sync-1");

      // Verify other values fetch independently
      load.mockImplementation(defaultLoad);
      await suspenseCache.get("sync-2");
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.lastCall?.[1]).toEqual("sync-2");
      expect(suspenseCache.peek("sync-2")).toEqual("sync-2");
    });
  });

  describe("set", () => {
    it("should make a value available immediately", () => {
      expect(suspenseCache.peek("sync")).toBeUndefined();
      suspenseCache.set(["sync"], "sync");
      expect(suspenseCache.peek("sync")).toEqual("sync");
    });

    it("should set the status to be overwritten ", () => {
      suspenseCache.set(["sync"], "sync");
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);
      suspenseCache.set(["sync"], "sync-2");
      expect(suspenseCache.getStatus("sync")).toBe(CacheStatus.RESOLVED);
    });

    it("should allow shorthand for no-arg keys", () => {
      const suspenseCache = cache(async () => "value");
      suspenseCache.set([], "value");
      expect(suspenseCache.peek()).toEqual("value");
      suspenseCache.set("value-2");
      expect(suspenseCache.peek()).toEqual("value-2");
    });

    it("should show a type error for >1 arg keys when attempting shorthand", () => {
      const suspenseCache = cache(async (_, __: string) => "value");
      // @ts-expect-error
      suspenseCache.set("value");
    });
  });

  describe("subscribe", () => {
    let callbackA: Mock;
    let callbackB: Mock;

    beforeEach(() => {
      callbackA = vi.fn();
      callbackB = vi.fn();
    });

    it("should subscribe to keys that have not been loaded", async () => {
      suspenseCache.subscribe(["sync"], (record) => callbackA(record));

      expect(callbackA).toHaveBeenCalledTimes(0);

      await Promise.resolve();

      expect(callbackA).toHaveBeenCalledTimes(0);
    });

    it("should notify of the transition from undefined to resolved for synchronous caches", async () => {
      suspenseCache.subscribe(["sync"], (record) => callbackA(record));

      expect(callbackA).toHaveBeenCalledTimes(0);

      await suspenseCache.get("sync");

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it("should notify of the transition from undefined to pending to resolved for async caches", async () => {
      suspenseCache.subscribe(["async"], (record) => callbackA(record));

      expect(callbackA).toHaveBeenCalledTimes(0);

      const thenable = suspenseCache.get("async");

      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);

      await thenable;

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it("should only notify each subscriber once", async () => {
      suspenseCache.subscribe(["sync"], (record) => callbackA(record));
      suspenseCache.subscribe(["sync"], (record) => callbackB(record));

      expect(callbackA).toHaveBeenCalledTimes(0);

      expect(callbackB).toHaveBeenCalledTimes(0);

      await suspenseCache.get("sync");

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it("should not notify after a subscriber unsubscribes", async () => {
      const unsubscribe = suspenseCache.subscribe(["sync"], (record) =>
        callbackA(record)
      );

      await suspenseCache.get("sync");

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      unsubscribe();

      suspenseCache.get("sync");

      expect(callbackA).toHaveBeenCalledTimes(2);
    });

    it("should track subscribers separately, per key", async () => {
      suspenseCache.subscribe(["sync-1"], (record) => callbackA(record));
      suspenseCache.subscribe(["sync-2"], (record) => callbackB(record));

      callbackA.mockReset();
      callbackB.mockReset();

      await suspenseCache.get("sync-2");

      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalledTimes(2);
    });

    it("should track un-subscriptions separately, per key", async () => {
      const unsubscribeA = suspenseCache.subscribe(["sync-1"], (record) =>
        callbackA(record)
      );
      suspenseCache.subscribe(["sync-2"], (record) => callbackB(record));

      callbackA.mockReset();
      callbackB.mockReset();

      unsubscribeA();

      await suspenseCache.get("sync-1");
      await suspenseCache.get("sync-2");

      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalledTimes(2);
    });

    it("should notify subscribers after a value is deleted", async () => {
      suspenseCache.subscribe(["sync-1"], (record) => callbackA(record));
      suspenseCache.subscribe(["sync-2"], (record) => callbackB(record));

      await suspenseCache.get("sync-1");
      await suspenseCache.get("sync-2");

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      suspenseCache.delete("sync-1");

      expect(callbackA).toHaveBeenCalledTimes(3);
      expect(callbackA).toHaveBeenCalledWith(null);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it("should notify subscribers after all values are deleted", async () => {
      suspenseCache.subscribe(["sync-1"], (record) => callbackA(record));
      suspenseCache.subscribe(["sync-2"], (record) => callbackB(record));
      await suspenseCache.get("sync-1");
      await suspenseCache.get("sync-2");

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      suspenseCache.clear();

      expect(callbackA).toHaveBeenCalledTimes(3);
      expect(callbackA).toHaveBeenCalledWith(null);
      expect(callbackB).toHaveBeenCalledTimes(3);
      expect(callbackB).toHaveBeenCalledWith(null);
    });
  });

  describe("structural sharing", () => {
    it("should share the same object reference for the same value when invalidated", async () => {
      const fn = vi.fn(async () => ({
        value: "value",
      }));
      const suspenseCache = cache(fn);

      const value1 = await suspenseCache.get();
      suspenseCache.invalidate();
      const value2 = await suspenseCache.get();
      expect(Object.is(value1, value2)).toBe(true);
    });
    it("should not share the same object reference when deleted", async () => {
      const fn = vi.fn(async () => ({
        value: "value",
      }));
      const suspenseCache = cache(fn);

      const value1 = await suspenseCache.get();
      suspenseCache.delete();
      const value2 = await suspenseCache.get();
      expect(Object.is(value1, value2)).toBe(false);
    });
  });

  describe("getCache: LRU Cache", () => {
    type Response = string;
    let onEvictFn: Mock<[string], void>;
    let load: Mock<[CacheLoadContext, string], Promise<Response>>;
    let lruCache: SuspenseCache<[string], Response>;

    beforeEach(() => {
      onEvictFn = vi.fn();

      load = vi.fn();
      load.mockImplementation((_, key) => {
        if (key.startsWith("error")) {
          return Promise.reject(key);
        }
        return Promise.resolve(key);
      });

      lruCache = cache(load, {
        getCache: (onEvict) =>
          new LRUCache({
            max: 1,
            disposeAfter: (_value, key, reason) => {
              if (reason === "evict") {
                onEvictFn(key);
                onEvict(key);
              }
            },
          }),
      });
    });

    it("getStatus: should return not-found status if value has been deleted by provided cache", async () => {
      lruCache.set(["test"], "test");
      expect(lruCache.peek("test")).toEqual("test");

      lruCache.set(["test2"], "test2");

      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.getStatus("test")).toBe(undefined);
    });

    it("suspend: should throw if previously loaded value has been deleted by provided cache", async () => {
      let deferred: Deferred<Response>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });
      lruCache.set(["test"], "test");
      expect(lruCache.peek("test")).toEqual("test");

      lruCache.set(["test2"], "test2");
      expect(onEvictFn).toHaveBeenCalledTimes(1);
      expect(lruCache.getStatus("test")).toBe(undefined);

      expect(() => lruCache.use("test")).toThrow();
    });

    it("peek: should return undefined if previously loaded value has been deleted by provided cache", async () => {
      lruCache.set(["test"], "test");
      expect(lruCache.peek("test")).toEqual("test");

      lruCache.set(["test2"], "test2");
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek("test")).toBeUndefined();
      expect(lruCache.getStatus("test")).toBe(undefined);
    });

    it("read: should re-suspend if previously loaded value has been deleted by provided cache", async () => {
      let deferred: Deferred<Response>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });
      lruCache.set(["test"], "test");
      expect(lruCache.peek("test")).toEqual("test");

      lruCache.set(["test2"], "test2");
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek("test")).toBeUndefined();
      expect(lruCache.getStatus("test")).toBe(undefined);

      expect(() => lruCache.use("test")).toThrow();
    });

    it("get: should re-suspend if previously loaded value has been collected by provided cache", async () => {
      lruCache.set(["test"], "test");
      expect(lruCache.peek("test")).toEqual("test");

      lruCache.set(["test2"], "test2");
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek("test")).toBeUndefined();
      expect(lruCache.getStatus("test")).toBe(undefined);

      expect(await lruCache.get("test")).toEqual("test");
    });
  });

  describe("useStatus", () => {
    let suspenseCache: SuspenseCache<[string], string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string>>;
    let getCacheKey: Mock<[[string]], string>;
    let lastRenderedStatus: CacheStatus | undefined = undefined;
    let renderCount = 0;

    function Component({ string }: { string: string }): any {
      lastRenderedStatus = suspenseCache.useStatus(string);
      renderCount++;
      return lastRenderedStatus as any;
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, key) => {
        if (key.startsWith("error")) {
          return Promise.reject(key);
        }

        return Promise.resolve(key);
      });

      getCacheKey = vi.fn();
      getCacheKey.mockImplementation(([key]) => key.toString());

      suspenseCache = cache(fetch, {
        getKey: getCacheKey,
      });

      lastRenderedStatus = undefined;
      renderCount = 0;
    });

    it("should return not-found for keys that have not been loaded", () => {
      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="test" />);
      });

      expect(lastRenderedStatus).toBe(undefined);
    });

    it("should transition from pending to resolved", async () => {
      const promise = suspenseCache.get("async");

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="async" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await React.act(async () => await promise);

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
    });

    it("should transition from pending to rejected", async () => {
      const promise = suspenseCache.get("error");

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="error" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await React.act(async () => {
        try {
          await promise;
        } catch (error) {}
      });

      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it("should return resolved for keys that have already been loaded", async () => {
      const promise = suspenseCache.get("sync");
      await promise;

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="sync" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
    });

    it("should not be alerted to a value that has been overwritten", async () => {
      const promise = suspenseCache.get("sync");
      await promise;

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="sync" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);

      await React.act(async () => {
        suspenseCache.set(["sync"], "new-value");
      });

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(renderCount).toBe(1);
    });

    it("should return rejected for keys that have already failed", async () => {
      try {
        await suspenseCache.get("error");
      } catch (error) {}

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="error" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it("should update in response to an aborted request", async () => {
      let abortSignal: AbortSignal | undefined;
      let deferred: Deferred<string> | undefined;
      fetch.mockImplementation(async (ctx, _params) => {
        abortSignal = ctx.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get("async");
      expect(suspenseCache.getStatus("async")).toBe(CacheStatus.PENDING);

      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(<Component string="async" />);
      });

      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      React.act(() => {
        expect(suspenseCache.abort("async")).toBe(true);
      });
      expect(abortSignal?.aborted).toBe(true);

      await Promise.resolve();

      expect(lastRenderedStatus).toBe(undefined);
    });
  });

  describe("use", () => {
    let suspenseCache: SuspenseCache<[string], string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string>>;
    let getCacheKey: Mock<[[string]], string>;
    let lastRenderedValue: string | undefined = undefined;
    let renderCount = 0;
    let suspenseCount = 0;

    function Component({ string }: { string: string }): any {
      lastRenderedValue = suspenseCache.use(string);
      renderCount++;
      return lastRenderedValue;
    }

    function SuspenseComponent(): any {
      suspenseCount++;
      return null;
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, key) => {
        if (key.startsWith("async")) {
          return Promise.resolve(key);
        }
        if (key.startsWith("error")) {
          return Promise.reject(key);
        }
        return key;
      });

      getCacheKey = vi.fn();
      getCacheKey.mockImplementation(([key]) => key.toString());

      suspenseCache = cache(fetch, {
        getKey: getCacheKey,
      });

      lastRenderedValue = undefined;
      renderCount = 0;
      suspenseCount = 0;
    });
    it("should suspend on async values", async () => {
      const container = document.createElement("div");
      const root = createRoot(container);
      await React.act(async () => {
        root.render(
          <React.Suspense fallback={<SuspenseComponent />}>
            <Component string="async" />
          </React.Suspense>
        );
      });
      expect(suspenseCount).toBe(1);
    });

    it("should not suspend on resolved values", () => {
      suspenseCache.set(["sync"], "sync");
      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(
          <React.Suspense fallback={<SuspenseComponent />}>
            <Component string="sync" />
          </React.Suspense>
        );
      });
      expect(suspenseCount).toBe(0);
    });

    it("should update after consecutive sets", () => {
      suspenseCache.set(["sync"], "sync");
      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(
          <React.Suspense fallback={<SuspenseComponent />}>
            <Component string="sync" />
          </React.Suspense>
        );
      });
      expect(lastRenderedValue).toBe("sync");
      expect(renderCount).toBe(1);

      React.act(() => suspenseCache.set(["sync"], "sync-2"));
      expect(lastRenderedValue).toBe("sync-2");
      expect(renderCount).toBe(2);
    });

    it("should suspend when item is deleted", async () => {
      suspenseCache.set(["sync"], "sync");
      const container = document.createElement("div");
      const root = createRoot(container);
      React.act(() => {
        root.render(
          <React.Suspense fallback={<SuspenseComponent />}>
            <Component string="sync" />
          </React.Suspense>
        );
      });
      expect(lastRenderedValue).toBe("sync");
      expect(renderCount).toBe(1);
      expect(suspenseCount).toBe(0);

      await React.act(async () => suspenseCache.delete("sync"));
      expect(suspenseCount).toBe(0);
      expect(lastRenderedValue).toBe("sync");
      await React.act(async () => suspenseCache.get("sync"));
      expect(suspenseCount).toBe(0);
      expect(lastRenderedValue).toBe("sync");
      expect(renderCount).toBe(1);
    });

    it("should reach error boundary if error is thrown", async () => {
      suspenseCache.get("error");
      const container = document.createElement("div");
      const root = createRoot(container);
      let errorCaught = false;
      await React.act(async () => {
        root.render(
          <ErrorBoundary
            onError={() => {
              errorCaught = true;
            }}
          >
            <React.Suspense fallback={<SuspenseComponent />}>
              <Component string="error" />
            </React.Suspense>
          </ErrorBoundary>
        );
      });
      expect(suspenseCount).toBe(1);
      expect(errorCaught).toBe(true);
    });
  });

  describe("useSelector", () => {
    let suspenseCache: SuspenseCache<[string], Value>;
    let resourceCache: SuspenseResourceCache<{
      "/1": Mock<[CacheLoadContext, string], Promise<Value> | Value>;
    }>;
    type Value = {
      a: string;
      b: string;
    };
    let fetch: Mock<[CacheLoadContext, string], Promise<Value>>;
    let selector = (value: Value): string => value.b;

    let container: HTMLDivElement | null = null;

    let lastRenderedValue: string | undefined = undefined;
    let lastResourceRenderedValue: string | undefined = undefined;
    let renderCount = 0;
    let lastResourceRenderCount = 0;

    function Component({ cacheKey }: { cacheKey: string }): any {
      const value = suspenseCache.useSelector([cacheKey], selector);

      lastRenderedValue = value;
      renderCount++;

      return null;
    }

    function ResourceComponent({ cacheKey }: { cacheKey: string }): any {
      const value = resourceCache.useSelector(["/1", cacheKey], selector);

      lastResourceRenderedValue = value;
      lastResourceRenderCount++;

      return null;
    }

    async function mount(): Promise<void> {
      container = document.createElement("div");
      const root = createRoot(container);
      await React.act(async () => {
        root.render(
          <>
            <ErrorBoundary>
              <Component cacheKey="test" />
              <ResourceComponent cacheKey="test" />
            </ErrorBoundary>
          </>
        );
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, _key) => {
        return {
          a: "a",
          b: "b",
        };
      });

      container = null;

      suspenseCache = cache(fetch);

      resourceCache = cacheResource({
        "/1": fetch,
      });

      lastRenderedValue = undefined;
      lastResourceRenderedValue = undefined;
      renderCount = 0;
      lastResourceRenderCount = 0;
    });

    it("should return the selected value", async () => {
      await mount();

      expect(lastRenderedValue).toBe("b");
      expect(lastResourceRenderedValue).toBe("b");
    });

    it("should only re-render when the selected value changes", async () => {
      await mount();

      expect(lastRenderedValue).toBe("b");
      expect(lastResourceRenderedValue).toBe("b");

      await React.act(async () => {
        suspenseCache.set(["test"], { a: "a", b: "b" });
        resourceCache.set(["/1", "test"], { a: "a", b: "b" });
      });

      expect(lastRenderedValue).toBe("b");
      expect(lastResourceRenderedValue).toBe("b");
      expect(renderCount).toBe(2);
      expect(lastResourceRenderCount).toBe(1);

      await React.act(async () => {
        suspenseCache.set(["test"], { a: "a", b: "c" });
        resourceCache.set(["/1", "test"], { a: "a", b: "c" });
      });

      expect(lastRenderedValue).toBe("c");
      expect(lastResourceRenderedValue).toBe("c");
      expect(renderCount).toBe(3);
      expect(lastResourceRenderCount).toBe(2);
    });

    it("structurally shares non-primitive values", async () => {
      const suspenseCache = cache(async () => ({
        a: ["a", "b"],
      }));
      let renderCount = 0;
      function Component(): any {
        const value = suspenseCache.useSelector([], (value) => value.a);
        renderCount++;
        return value;
      }
      async function mount(): Promise<void> {
        container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(<Component />);
        });
      }
      await mount();
      expect(renderCount).toBe(1);
      await React.act(async () => {
        suspenseCache.set([], { a: ["a", "b"] });
      });
      expect(renderCount).toBe(1);
      await React.act(async () => {
        suspenseCache.set([], { a: ["a", "c"] });
      });
      expect(renderCount).toBe(2);
    });

    it("will suspend if the value is not yet loaded", async () => {
      const deferred = defer();
      const suspenseCache = cache(async () => {
        return deferred.promise;
      });

      let renderCount = 0;
      let suspenseCount = 0;
      function Component(): any {
        const value = suspenseCache.useSelector([], (value) => value);
        renderCount++;
        return value;
      }

      function Fallback(): any {
        suspenseCount++;
        return null;
      }

      async function mount(): Promise<void> {
        container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(
            <React.Suspense fallback={<Fallback />}>
              <Component />
            </React.Suspense>
          );
        });
      }

      await mount();

      expect(renderCount).toBe(0);
      expect(suspenseCount).toBe(1);
    });

    it("will throw error if the value is rejected", async () => {
      const suspenseCache = cache(async () => {
        return Promise.reject("error");
      });

      let renderCount = 0;
      let suspenseCount = 0;
      let errorCount = 0;
      function Component(): any {
        const value = suspenseCache.useSelector([], (value) => value);
        renderCount++;
        return value;
      }

      function Fallback(): any {
        suspenseCount++;
        return null;
      }

      async function mount(): Promise<void> {
        container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(
            <ErrorBoundary
              onError={() => {
                errorCount++;
              }}
            >
              <React.Suspense fallback={<Fallback />}>
                <Component />
              </React.Suspense>
            </ErrorBoundary>
          );
        });
      }

      await mount();

      expect(renderCount).toBe(0);
      expect(suspenseCount).toBe(1);
      expect(errorCount).toBeGreaterThan(0);
    });
  });
  describe("mutate", () => {
    it("should trigger a mutation and update cache on success", async () => {
      const deferredLoad = defer<string>();
      const deferredMutate = defer<string>();
      let suspenseCache = cache(async () => deferredLoad.promise);

      suspenseCache.set([], "test");

      let result = suspenseCache.mutate([], () => deferredMutate.promise);
      expect(suspenseCache.getStatus()).toBe(CacheStatus.RESOLVED);
      deferredMutate.resolve("mutated");
      await result;
      expect(suspenseCache.peek()).toBe("mutated");
    });

    it("should trigger a mutation and invalidate cache on error", async () => {
      const deferredLoad = defer<string>();
      const deferredMutate = defer<string>();
      let suspenseCache = cache(async () => deferredLoad.promise);

      suspenseCache.set([], "test");

      let result = suspenseCache.mutate([], () => deferredMutate.promise);
      expect(suspenseCache.getStatus()).toBe(CacheStatus.RESOLVED);
      deferredMutate.reject("mutated");
      try {
        await result;
      } catch {}
      expect(suspenseCache.getStatus()).toBe(CacheStatus.PENDING);
    });

    it("should only care about the last mutation", async () => {
      const deferredLoad = defer<string>();
      let suspenseCache = cache(async () => deferredLoad.promise);

      suspenseCache.set([], "test");

      const result1OnSuccess = vi.fn();
      const result2OnSuccess = vi.fn();

      const deferredMutate1 = defer<string>();
      const deferredMutate2 = defer<string>();
      let result1 = suspenseCache.mutate([], () => deferredMutate1.promise, {
        onSuccess: result1OnSuccess,
      });
      let result2 = suspenseCache.mutate([], () => deferredMutate2.promise, {
        onSuccess: result2OnSuccess,
      });
      expect(suspenseCache.getStatus()).toBe(CacheStatus.RESOLVED);
      deferredMutate1.resolve("mutated1");
      deferredMutate2.resolve("mutated2");
      await result1;
      await result2;
      expect(result1OnSuccess).not.toHaveBeenCalled();
      expect(result2OnSuccess).toHaveBeenCalled();
      expect(suspenseCache.peek()).toBe("mutated2");
    });
  });
  describe("useMutation", () => {
    let suspenseCache: SuspenseCache<[string], string>;
    let resourceCache: ReturnType<typeof createResourceCache>;

    // eslint-disable-next-line @typescript-eslint/explicit-function-return-type
    function createResourceCache() {
      return cacheResource({
        "/1": (_, _x: any) => ({} as any),
        "/2": (_, _x: any) => ({} as any),
      });
    }

    let fetch: Mock<[CacheLoadContext, any], Promise<any> | any>;
    let fetchResourceOne: Mock<[CacheLoadContext, any], Promise<any> | any>;
    let fetchResourceTwo: Mock<[CacheLoadContext, any], Promise<any> | any>;

    let container: HTMLDivElement | null = null;

    let pendingDeferred: Deferred<any>[] = [];
    let pendingResources: Record<string, Deferred<any>> = {};

    async function mount(component: React.ReactNode): Promise<void> {
      container = document.createElement("div");
      const root = createRoot(container);
      await React.act(async () => {
        root.render(component);
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();

        pendingDeferred.push(deferred);

        return deferred.promise;
      });

      fetchResourceOne = vi.fn();
      fetchResourceOne.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();
        pendingResources["/1"] = deferred;
        return deferred.promise;
      });

      fetchResourceTwo = vi.fn();
      fetchResourceTwo.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();
        pendingResources["/2"] = deferred;
        return deferred.promise;
      });

      container = null;

      suspenseCache = cache(fetch);
      resourceCache = cacheResource({
        "/1": fetchResourceOne,
        "/2": fetchResourceTwo,
      });

      pendingDeferred = [];
      pendingResources = {};
    });

    it("should return the correct status", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;
      const deferredMutator = defer<any>();

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["test"],
          () => deferredMutator.promise
        );
        trigger = _trigger;
        pending = _pending;
        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "s"],
          () => deferredMutator.promise
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!();
        resourceTrigger!();
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      await React.act(async () => {
        deferredMutator.resolve();
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);
    });

    it("should invalidate the provided caches on successful mutation", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      suspenseCache.set(["1"], "1");
      resourceCache.set(["/1", "1"], "1");

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!();
        resourceTrigger!();
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      await React.act(async () => {
        deferredMutator.resolve();
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.getStatus("1")).toBe(CacheStatus.PENDING);
      expect(resourceCache.getStatus("/1", "1")).toBe(CacheStatus.PENDING);
    });

    it("should invalidate the provided caches on failed mutation", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      suspenseCache.set(["1"], "1");
      resourceCache.set(["/1", "1"], "1");

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!().catch(() => {});
        resourceTrigger!().catch(() => {});
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      await React.act(async () => {
        deferredMutator.reject("reject");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.getStatus("1")).toBe(CacheStatus.PENDING);
      expect(resourceCache.getStatus("/1", "1")).toBe(CacheStatus.PENDING);
    });

    it("should update the provided update caches with the result of the mutation", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<string>();

      suspenseCache.set(["1"], "1");
      resourceCache.set(["/1", "1"], "1");

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!();
        resourceTrigger!();
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      await React.act(async () => {
        deferredMutator.resolve("resolved");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.peek("1")).toBe("resolved");
      expect(resourceCache.peek("/1", "1")).toBe("resolved");
    });

    it("should optimistically update the update caches with the provided value", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<string>();

      suspenseCache.set(["1"], "1");
      resourceCache.set(["/1", "1"], "1");

      function MutatingComponent(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceMutatingComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      let lastRenderedValue: string | undefined = undefined;
      let renderCount = 0;
      function CacheReadingComponent(): any {
        let value = suspenseCache.use("1");
        lastRenderedValue = value;
        renderCount++;
        return null;
      }

      let lastRenderedResourceValue: string | undefined = undefined;
      let renderResourceCount = 0;
      function ResourceCacheReadingComponent(): any {
        let value = resourceCache.use("/1", "1");
        lastRenderedResourceValue = value;
        renderResourceCount++;
        return null;
      }

      await mount(
        <>
          <MutatingComponent />
          <ResourceMutatingComponent />
          <React.Suspense fallback={null}>
            <CacheReadingComponent />
            <ResourceCacheReadingComponent />
          </React.Suspense>
        </>
      );

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!();
        resourceTrigger!();
      });

      expect(lastRenderedValue).toBe("optimistic");
      expect(pending).toBe(true);
      expect(renderCount).toBe(2);
      expect(lastRenderedResourceValue).toBe("optimistic");
      expect(renderResourceCount).toBe(2);
      expect(resourcePending).toBe(true);

      expect(suspenseCache.peek("1")).toBe("optimistic");
      expect(resourceCache.peek("/1", "1")).toBe("optimistic");

      await React.act(async () => {
        deferredMutator.resolve("new-value");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.peek("1")).toBe("new-value");
      expect(resourceCache.peek("/1", "1")).toBe("new-value");

      expect(lastRenderedValue).toBe("new-value");
      expect(lastRenderedResourceValue).toBe("new-value");
      expect(renderCount).toBe(3);
      expect(renderResourceCount).toBe(3);
    });

    it("should create optimistic data based on args if it's a function", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: ((id: string) => Promise<any>) | undefined = undefined;
      let resourceTrigger: ((id: string) => Promise<any>) | undefined =
        undefined;
      let fn = vi.fn();

      const deferredMutator = defer<string>();

      suspenseCache.set(["1"], "1");
      resourceCache.set(["/1", "1"], "1");

      function MutatingComponent(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          (_, id: string) => {
            fn(id);
            return deferredMutator.promise;
          },

          {
            optimisticData: (id) => `optimistic-${id}`,
          }
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function MutatingResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          (_, id: string) => {
            fn(id);
            return deferredMutator.promise;
          },

          {
            optimisticData: (id) => `optimistic-${id}`,
          }
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      let lastRenderedValue: string | undefined = undefined;
      let renderCount = 0;
      function CacheReadingComponent(): any {
        let value = suspenseCache.use("1");
        lastRenderedValue = value;
        renderCount++;
        return null;
      }

      let lastRenderedResourceValue: string | undefined = undefined;
      let renderResourceCount = 0;
      function ResourceCacheReadingComponent(): any {
        let value = resourceCache.use("/1", "1");
        lastRenderedResourceValue = value;
        renderResourceCount++;
        return null;
      }

      await mount(
        <>
          <MutatingComponent />
          <MutatingResourceComponent />
          <React.Suspense>
            <CacheReadingComponent />
            <ResourceCacheReadingComponent />
          </React.Suspense>
        </>
      );

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!("test");
        resourceTrigger!("test");
      });

      expect(lastRenderedValue).toBe("optimistic-test");
      expect(renderCount).toBe(2);
      expect(pending).toBe(true);
      expect(renderResourceCount).toBe(2);
      expect(lastRenderedResourceValue).toBe("optimistic-test");
      expect(resourcePending).toBe(true);
      expect(fn).toHaveBeenCalledWith("test");

      expect(suspenseCache.peek("1")).toBe("optimistic-test");
      expect(resourceCache.peek("/1", "1")).toBe("optimistic-test");

      await React.act(async () => {
        deferredMutator.resolve("new-value");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.peek("1")).toBe("new-value");
      expect(resourceCache.peek("/1", "1")).toBe("new-value");

      expect(lastRenderedValue).toBe("new-value");
      expect(lastRenderedResourceValue).toBe("new-value");
      expect(renderCount).toBe(3);
      expect(renderResourceCount).toBe(3);
    });

    it("should rollback the provided update caches on a failed mutation with an optimistic update", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      suspenseCache.set(["1"], "1");

      resourceCache.set(["/1", "1"], "1");

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );

        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;

        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!().catch(() => {});
        resourceTrigger!().catch(() => {});
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      expect(suspenseCache.peek("1")).toBe("optimistic");
      expect(resourceCache.peek("/1", "1")).toBe("optimistic");

      await React.act(async () => {
        deferredMutator.reject("rejected");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.getStatus("1")).toBe(CacheStatus.PENDING);
      expect(resourceCache.getStatus("/1", "1")).toBe(CacheStatus.PENDING);
    });

    it("should invalidate instead of rollback the provided caches with an optimistic update on a failed mutation if the original status was not resolved", async () => {
      let pending: boolean | undefined = undefined;
      let resourcePending: boolean | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let resourceTrigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      function Component(): any {
        const [_trigger, _pending] = suspenseCache.useMutation(
          ["1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );
        trigger = _trigger;
        pending = _pending;

        return null;
      }

      function ResourceComponent(): any {
        const [_resourceTrigger, _resourcePending] = resourceCache.useMutation(
          ["/1", "1"],
          () => deferredMutator.promise,
          {
            optimisticData: "optimistic",
          }
        );
        resourceTrigger = _resourceTrigger;
        resourcePending = _resourcePending;
        return null;
      }

      await mount(<Component />);
      await mount(<ResourceComponent />);

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      await React.act(async () => {
        trigger!().catch(() => {});
        resourceTrigger!().catch(() => {});
      });

      expect(pending).toBe(true);
      expect(resourcePending).toBe(true);

      expect(suspenseCache.peek("1")).toBe("optimistic");
      expect(resourceCache.peek("/1", "1")).toBe("optimistic");

      await React.act(async () => {
        deferredMutator.reject("rejected");
      });

      expect(pending).toBe(false);
      expect(resourcePending).toBe(false);

      expect(suspenseCache.getStatus("1")).toBe(CacheStatus.PENDING);
      expect(resourceCache.getStatus("/1", "1")).toBe(CacheStatus.PENDING);
    });
  });

  describe("useImperativeValue", () => {
    it("should load the cache and return the value", async () => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;
      let deferred: Deferred<string>;
      const suspenseCache = cache(async () => {
        deferred = defer();
        return deferred.promise;
      });
      let lastRenderedValue: unknown | undefined = undefined;
      let lastRenderedStatus: CacheResultStatus | undefined = undefined;
      function Component(): any {
        const [status, value] = suspenseCache.useImperativeValue();
        lastRenderedValue = value;
        lastRenderedStatus = status;
        return null;
      }

      async function mount(): Promise<void> {
        const container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(<Component />);
        });
      }

      await mount();

      expect(lastRenderedValue).toBe(undefined);
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await React.act(async () => {
        deferred.resolve("test");
      });

      expect(lastRenderedValue).toBe("test");
      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);

      await React.act(async () => {
        suspenseCache.delete();
      });

      expect(lastRenderedValue).toBe(undefined);
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await React.act(async () => {
        deferred.reject("error");
      });

      expect(lastRenderedValue).toBe("error");
      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it("should correctly update the cache when the value changes", async () => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;
      let deferred: Deferred<string>;
      const suspenseCache = cache(async () => {
        deferred = defer();
        return deferred.promise;
      });
      let renderCount = 0;
      function Component(): any {
        suspenseCache.useImperativeValue();
        renderCount++;
        return null;
      }

      async function mount(): Promise<void> {
        const container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(<Component />);
        });
      }

      await mount();

      expect(renderCount).toBe(1);

      await React.act(async () => {
        deferred.resolve("test");
      });

      expect(renderCount).toBe(2);

      await React.act(async () => {
        suspenseCache.delete();
      });

      expect(renderCount).toBe(3);
      await React.act(async () => {
        deferred.reject("error");
      });

      expect(renderCount).toBe(4);

      await React.act(async () => {
        suspenseCache.set("test-2");
      });

      expect(renderCount).toBe(5);

      await React.act(async () => {
        suspenseCache.set("test-2");
      });

      expect(renderCount).toBe(6);

      await React.act(async () => {
        suspenseCache.invalidate();
      });

      expect(renderCount).toBe(7);
    });

    it("should return the lastValue when the cache is invalidated", async () => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;
      let deferred: Deferred<string>;
      const suspenseCache = cache(async () => {
        deferred = defer();
        return deferred.promise;
      });
      let lastRenderedValue: unknown | undefined = undefined;
      let lastRenderedStatus: CacheResultStatus | undefined = undefined;
      function Component(): any {
        const [status, value] = suspenseCache.useImperativeValue();
        lastRenderedValue = value;
        lastRenderedStatus = status;
        return null;
      }

      async function mount(): Promise<void> {
        const container = document.createElement("div");
        const root = createRoot(container);
        await React.act(async () => {
          root.render(<Component />);
        });
      }

      await mount();

      expect(lastRenderedValue).toBe(undefined);
      expect(lastRenderedStatus).toBe(CacheResultStatus.PENDING);

      await React.act(async () => {
        deferred.resolve("test");
      });

      expect(lastRenderedValue).toBe("test");
      expect(lastRenderedStatus).toBe(CacheResultStatus.RESOLVED);

      await React.act(async () => {
        suspenseCache.invalidate();
      });

      expect(lastRenderedValue).toBe("test");
      expect(lastRenderedStatus).toBe(CacheResultStatus.REVALIDATING);
    });
  });

  describe("cacheResource", () => {
    it("should call the provided resources without the resource key", () => {
      const resourceOneLoad = vi.fn();
      const resourceTwoLoad = vi.fn();

      resourceOneLoad.mockImplementation(defaultLoad);
      resourceTwoLoad.mockImplementation(defaultLoad);

      const resource = {
        "/1": resourceOneLoad,
        "/2": resourceTwoLoad,
      };
      const cache = cacheResource(resource);

      cache.get("/1", "test", "keys");
      cache.get("/2", "test", "keys");

      expect(resourceOneLoad).toHaveBeenCalledTimes(1);
      expect(resourceTwoLoad).toHaveBeenCalledTimes(1);

      expect(resourceOneLoad).toHaveBeenCalledWith(
        expect.anything(),
        "test",
        "keys"
      );
      expect(resourceTwoLoad).toHaveBeenCalledWith(
        expect.anything(),
        "test",
        "keys"
      );
    });

    it("should call the provided getKey functions without the resource key", () => {
      const resourceOneLoad = vi.fn();
      const resourceTwoLoad = vi.fn();

      resourceOneLoad.mockImplementation(defaultLoad);
      resourceTwoLoad.mockImplementation(defaultLoad);

      const resource = {
        "/1": resourceOneLoad,
        "/2": resourceTwoLoad,
      };

      let argsArr: any[][] = [];

      const cache = cacheResource(resource, {
        getKey: (args) => {
          argsArr.push(args);
          return args.join(",");
        },
      });

      cache.get("/1", "test", "keys");
      cache.get("/2", "test", "keys");

      expect(argsArr[0]).toEqual(["/1", "test", "keys"]);
      expect(argsArr[1]).toEqual(["/2", "test", "keys"]);
    });

    it("should call the provided onSuccess functions without the resource key", async () => {
      let deferredOne = defer<string>();
      let deferredTwo = defer<string>();
      const resourceOneLoad = vi.fn(
        (_: any, _key: string, _key2: string) => deferredOne.promise
      );
      const resourceTwoLoad = vi.fn(
        (_: any, _key: string, _key2: string) => deferredTwo.promise
      );

      const resource = {
        "/1": resourceOneLoad,
        "/2": resourceTwoLoad,
      };

      let resourceOneOnSuccess = vi.fn();
      let resourceTwoOnSuccess = vi.fn();
      const cache = cacheResource(resource, {
        onSuccess: (...args) => {
          const [[key, ...keys], error] = args;
          if (key === "/1") {
            return resourceOneOnSuccess(keys, error);
          }
          return resourceTwoOnSuccess(keys, error);
        },
      });

      const promiseOne = cache.get("/1", "test", "keys");
      const promiseTwo = cache.get("/2", "test", "keys");

      expect(resourceOneOnSuccess).not.toHaveBeenCalled();
      expect(resourceTwoOnSuccess).not.toHaveBeenCalled();

      deferredOne.resolve("value");
      await promiseOne;

      expect(resourceOneOnSuccess).toHaveBeenCalledTimes(1);
      expect(resourceOneOnSuccess).toHaveBeenCalledWith(
        ["test", "keys"],
        "value"
      );

      deferredTwo.resolve("value");
      await promiseTwo;
      expect(resourceTwoOnSuccess).toHaveBeenCalledTimes(1);
      expect(resourceTwoOnSuccess).toHaveBeenCalledWith(
        ["test", "keys"],
        "value"
      );
    });

    it("should call the provided onError functions without the resource key", async () => {
      let deferredOne = defer<string>();
      let deferredTwo = defer<string>();
      const resourceOneLoad = vi.fn(
        (_: any, _key: string, _key2: string) => deferredOne.promise
      );
      const resourceTwoLoad = vi.fn(
        (_: any, _key: string, _key2: string) => deferredTwo.promise
      );

      const resource = {
        "/1": resourceOneLoad,
        "/2": resourceTwoLoad,
      };

      let resourceOneOnError = vi.fn();
      let resourceTwoOnError = vi.fn();
      const cache = cacheResource(resource, {
        onError: (...args) => {
          const [[key, ...keys], error] = args;
          if (key === "/1") {
            return resourceOneOnError(keys, error);
          }
          return resourceTwoOnError(keys, error);
        },
      });

      const promiseOne = cache.get("/1", "test", "keys");
      const promiseTwo = cache.get("/2", "test", "keys");

      expect(resourceOneOnError).not.toHaveBeenCalled();
      expect(resourceTwoOnError).not.toHaveBeenCalled();

      deferredOne.reject("value");
      await promiseOne.catch(() => {});

      expect(resourceOneOnError).toHaveBeenCalledTimes(1);
      expect(resourceOneOnError).toHaveBeenCalledWith(
        ["test", "keys"],
        "value"
      );

      deferredTwo.reject("value");
      await promiseTwo.catch(() => {});
      expect(resourceTwoOnError).toHaveBeenCalledTimes(1);
      expect(resourceTwoOnError).toHaveBeenCalledWith(
        ["test", "keys"],
        "value"
      );
    });
  });

  describe("options", () => {
    it("should call getKey", () => {
      let load = vi.fn(async (_ctx: any, _id: string) => "test");
      let getKey = vi.fn(() => "test");
      const suspenseCache = cache(load, {
        getKey,
      });

      suspenseCache.get("test");

      expect(getKey).toHaveBeenCalledTimes(1);
      expect(getKey).toHaveBeenCalledWith(["test"]);
    });

    it("should call onSuccess", async () => {
      let deferred = defer<string>();
      let load = vi.fn((_ctx: any) => deferred.promise);

      let onSuccess = vi.fn();

      const suspenseCache = cache(load, {
        onSuccess,
      });

      const res = suspenseCache.get();
      expect(res).toBeInstanceOf(Promise);
      expect(onSuccess).not.toHaveBeenCalled();
      deferred.resolve("test");
      await res;
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith([], "test");
    });

    it("should call onSuccess with the arguments passed to the load function", async () => {
      let deferred = defer<string>();
      let load = vi.fn((_ctx: any, _id: string) => deferred.promise);

      let onSuccess = vi.fn();

      const suspenseCache = cache(load, {
        onSuccess,
      });

      const res = suspenseCache.get("test");
      expect(res).toBeInstanceOf(Promise);
      expect(onSuccess).not.toHaveBeenCalled();
      deferred.resolve("test");
      await res;
      expect(onSuccess).toHaveBeenCalledTimes(1);
      expect(onSuccess).toHaveBeenCalledWith(["test"], "test");
    });

    it("should call onError", async () => {
      let deferred = defer<string>();
      let load = vi.fn((_ctx: any) => deferred.promise);

      let onError = vi.fn();

      const suspenseCache = cache(load, {
        onError,
      });

      const res = suspenseCache.get();
      expect(res).toBeInstanceOf(Promise);
      expect(onError).not.toHaveBeenCalled();
      deferred.reject("test");
      await res.catch(() => {});
      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith([], "test");
    });
  });
});
