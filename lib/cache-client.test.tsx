import * as React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import {
  CacheProvider,
  MissingLoaderError,
  CacheClient,
  CacheClientOptions,
  makeCacheKey,
  CacheOptionsProvider,
} from "./cache-client";
import { ErrorBoundary } from "./test-utils";
import {
  CacheLoadContext,
  CacheStatus,
  Deferred,
  MutationStatus,
} from "./types";
import { defer, isPromiseLike } from "./utils";

describe("CacheClient", () => {
  let container: HTMLDivElement | undefined;
  const key = "key";

  let onSuccess = vi.fn();
  let onError = vi.fn();
  let client = new CacheClient({
    onSuccess,
    onError,
  });

  let lastThrownError: Error | undefined;
  let suspenseCount = 0;
  let renderCount = 0;

  function Fallback() {
    suspenseCount++;
    return null;
  }

  async function mount(component: React.ReactNode) {
    container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <CacheProvider client={client}>
          <ErrorBoundary
            onError={(e) => {
              lastThrownError = e;
            }}
          >
            <React.Suspense fallback={<Fallback />}>{component}</React.Suspense>
          </ErrorBoundary>
        </CacheProvider>
      );
    });
  }

  beforeEach(() => {
    // @ts-ignore
    global.IS_REACT_ACT_ENVIRONMENT = true;

    lastThrownError = undefined;
    suspenseCount = 0;
    renderCount = 0;

    onSuccess = vi.fn();
    onError = vi.fn();
    client = new CacheClient({
      onSuccess,
      onError,
    });
  });

  describe("options", () => {
    it("should prime the cache with the default options", async () => {
      let key1Load = vi.fn(async () => "value1");
      let key2Load = vi.fn(async () => "value2");
      let key3Load = vi.fn(async () => "value3");
      let primer: CacheClientOptions["primer"] = {
        key1: {
          load: key1Load,
        },
        key2: {
          load: key2Load,
        },
        key3: {
          load: key3Load,
        },
      };

      let client = new CacheClient({
        primer,
      });

      expect(client.cacheMap.size).toBe(3);
      expect(client.cacheMap.get("key1")).toBeDefined();
      expect(isPromiseLike(client.get(["key1"]))).toBe(true);
      expect(key1Load).toHaveBeenCalled();

      key1Load = vi.fn(async () => "value1");
      key2Load = vi.fn(async () => "value2");
      key3Load = vi.fn(async () => "value3");

      primer = {
        key1: {
          load: key1Load,
          initialData: "value1",
        },
        key2: {
          load: key2Load,
          initialData: "value2",
        },
        key3: {
          load: key3Load,
          initialData: "value3",
        },
      };

      client = new CacheClient({
        primer,
      });

      expect(client.cacheMap.size).toBe(3);
      expect(client.cacheMap.get("key1")).toBeDefined();
      expect(client.get(["key1"])).toBe("value1");
      expect(key1Load).not.toHaveBeenCalled();
    });

    it("should prime the cache with non simple keys", async () => {
      let load = vi.fn(async () => "value");
      const key = ["key1", { id: 1 }] as const;
      let primer: CacheClientOptions["primer"] = {
        [makeCacheKey(key)]: {
          load,
          initialData: "value1",
        },
      };

      let client = new CacheClient({
        primer,
      });

      expect(client.cacheMap.size).toBe(1);
      expect(client.get(key)).toBe("value1");
    });
  });

  describe("suspend", () => {
    let lastRenderedValue: string | undefined;
    beforeEach(() => {
      lastRenderedValue = undefined;
    });

    function Component({ fn }: { fn?: () => Promise<string> }) {
      const value = client.suspend([key], {
        load: fn,
      });
      lastRenderedValue = value;
      renderCount++;
      return null;
    }

    it("should trigger the onSuccess callback when the cache item loads successfully", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      await mount(<Component fn={() => deferred.promise} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      expect(onSuccess).not.toHaveBeenCalled();
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toBe("value");
      expect(onSuccess).toHaveBeenCalledWith("value");
    });

    it("should suspend when cache is missing", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      await mount(<Component fn={() => deferred.promise} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toBe("value");
    });

    it("should not update if the cache is updated", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      const load = () => deferred.promise;
      await mount(<Component fn={load} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toBe("value");
      const cache = client.cacheMap.get(key);
      await act(async () => {
        cache!.set("value2");
      });
      expect(lastRenderedValue).toBe("value");
      expect(suspenseCount).toBe(1);
      expect(renderCount).toBe(1);
    });

    it("should return a cached value for a key if it exists without a load function", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      await mount(<Component fn={() => deferred.promise} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toBe("value");

      await mount(<Component />);
      expect(lastRenderedValue).toBe("value");
      expect(suspenseCount).toBe(1);
      expect(renderCount).toBe(2);
    });

    it("should should throw a CacheMissingLoaderError for a given key if no load function exists", async () => {
      let old = console.error;
      console.error = () => {};
      await mount(<Component />);
      expect(lastRenderedValue).toBe(undefined);
      expect(lastThrownError).toEqual(new MissingLoaderError(key).message);
      expect(suspenseCount).toBe(0);
      expect(renderCount).toBe(0);
      console.error = old;
    });

    it("should render the error boundary if the load function throws", async () => {
      let old = console.error;
      console.error = () => {};
      const load = async () => {
        throw new Error("error");
      };
      await mount(<Component fn={load} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(lastThrownError).toEqual("error");
      console.error = old;
    });
  });

  describe("read", () => {
    let lastRenderedValue: [string, boolean] | undefined;
    beforeEach(() => {
      lastRenderedValue = undefined;
    });

    function Component({ fn }: { fn?: () => Promise<string> }) {
      const value = client.read([key], {
        load: fn,
      });
      lastRenderedValue = value;
      renderCount++;
      return null;
    }

    it("should suspend when cache is missing", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      await mount(<Component fn={() => deferred.promise} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toEqual(["value", false]);
    });

    it("should update if the cache is updated", async () => {
      let deferred: Deferred<string>;
      const trigger = () => deferred.resolve("value");
      const load = vi.fn(() => {
        deferred = defer();
        return deferred.promise;
      });
      await mount(<Component fn={load} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toEqual(["value", false]);
      const cache = client.cacheMap.get(key);

      await act(async () => {
        cache!.invalidate();
      });
      expect(lastRenderedValue).toEqual(["value", true]);
      await act(async () => {
        deferred.resolve("value2");
      });

      expect(lastRenderedValue).toEqual(["value2", false]);
    });

    it("should return a cached value for a key if it exists without a load function", async () => {
      const deferred = defer<string>();
      const trigger = () => deferred.resolve("value");
      await mount(<Component fn={() => deferred.promise} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(suspenseCount).toBe(1);
      await act(async () => {
        trigger();
      });
      expect(lastRenderedValue).toEqual(["value", false]);

      await mount(<Component />);
      expect(lastRenderedValue).toEqual(["value", false]);
    });

    it("should should throw a CacheMissingLoaderError for a given key if no load function exists", async () => {
      let old = console.error;
      console.error = () => {};
      await mount(<Component />);
      expect(lastRenderedValue).toBe(undefined);
      expect(lastThrownError).toEqual(new MissingLoaderError(key).message);
      expect(suspenseCount).toBe(0);
      expect(renderCount).toBe(0);
      console.error = old;
    });

    it("should render the error boundary if the load function throws", async () => {
      let old = console.error;
      console.error = () => {};
      const load = async () => {
        throw new Error("error");
      };
      await mount(<Component fn={load} />);
      expect(lastRenderedValue).toBeUndefined();
      expect(lastThrownError).toEqual("error");
      console.error = old;
    });
  });

  describe("useMutation", () => {
    const numberKey = "cacheNumber";
    const stringKey = "cacheString";
    let load = vi.fn(async (_: CacheLoadContext) => {
      const deferred = defer<any>();

      pendingDeferred.push(deferred);

      return deferred.promise;
    });
    let client = new CacheClient({
      primer: {
        [stringKey]: { load },
        [numberKey]: { load },
      },
    });

    let container: HTMLDivElement | null = null;

    let pendingDeferred: Deferred<any>[] = [];

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      load = vi.fn(async (_: CacheLoadContext) => {
        const deferred = defer<any>();

        pendingDeferred.push(deferred);

        return deferred.promise;
      });

      client = new CacheClient({
        primer: {
          [stringKey]: { load },
          [numberKey]: { load },
        },
      });

      container = null;
      pendingDeferred = [];
    });

    async function mount(component: React.ReactNode) {
      container = document.createElement("div");
      const root = createRoot(container);
      await act(async () => {
        root.render(<CacheProvider client={client}>{component}</CacheProvider>);
      });
    }

    it("should return the correct status", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let reset: (() => void) | undefined = undefined;

      const deferredMutator = defer<any>();

      function Component(): any {
        let result = client.useMutation(
          [[stringKey]],
          () => deferredMutator.promise
        );

        status = result.status;
        trigger = result.trigger;
        reset = result.reset;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!();
      });

      expect(status).toBe(MutationStatus.PENDING);

      await act(async () => {
        deferredMutator.resolve();
      });

      expect(status).toBe(MutationStatus.RESOLVED);
      await act(async () => {
        reset!();
      });

      expect(status).toBe(MutationStatus.IDLE);
    });

    it("should invalidate the provided caches on successful mutation", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      client.set("1", [stringKey]);
      client.set(1, [numberKey]);

      function Component(): any {
        let result = client.useMutation(
          [[stringKey], [numberKey]],
          () => deferredMutator.promise
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!();
      });

      expect(status).toBe(MutationStatus.PENDING);

      await act(async () => {
        deferredMutator.resolve();
      });

      expect(status).toBe(MutationStatus.RESOLVED);

      expect(client.getStatus([stringKey])).toBe(CacheStatus.REVALIDATING);
      expect(client.getStatus([numberKey])).toBe(CacheStatus.REVALIDATING);
    });

    it("should not invalidate the provided caches on failed mutation", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      client.set("1", [stringKey]);
      client.set(1, [numberKey]);

      function Component(): any {
        let result = client.useMutation(
          [[stringKey], [numberKey]],
          () => deferredMutator.promise
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!().catch(() => {});
      });

      expect(status).toBe(MutationStatus.PENDING);

      await act(async () => {
        deferredMutator.reject("reject");
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(client.getStatus([stringKey])).toBe(CacheStatus.RESOLVED);
      expect(client.getStatus([numberKey])).toBe(CacheStatus.RESOLVED);
    });

    it("should update the provided update caches with the result of the mutation", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      client.set("1", [stringKey]);
      client.set(1, [numberKey]);

      function Component(): any {
        let result = client.useMutation(
          [[stringKey], [numberKey]],
          () => deferredMutator.promise,
          {
            updates: [[stringKey]],
          }
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!();
      });

      expect(status).toBe(MutationStatus.PENDING);

      await act(async () => {
        deferredMutator.resolve("resolved");
      });

      expect(status).toBe(MutationStatus.RESOLVED);

      expect(client.get([stringKey])).toBe("resolved");
      expect(client.get([numberKey])).toBe(1);
    });

    it("should optimistically update the provided update caches with the provided value", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      client.set("1", [stringKey]);
      client.set(1, [numberKey]);

      function MutatingComponent(): any {
        let result = client.useMutation(
          [[stringKey], [numberKey]],
          () => deferredMutator.promise,
          {
            updates: [[stringKey]],
            optimisticData: "optimistic",
          }
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      let lastRenderedValue: string | undefined = undefined;
      let renderCount = 0;
      function CacheReadingComponent(): any {
        const key = [stringKey] as const;
        let [value] = client.read<string, typeof key>([stringKey]);
        lastRenderedValue = value;
        renderCount++;
        return null;
      }

      await mount(
        <>
          <MutatingComponent />
          <React.Suspense>
            <CacheReadingComponent />
          </React.Suspense>
        </>
      );

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!();
      });

      expect(status).toBe(MutationStatus.PENDING);
      expect(lastRenderedValue).toBe("optimistic");
      expect(renderCount).toBe(2);

      expect(client.get([stringKey])).toBe("optimistic");

      expect(client.get([numberKey])).toBe(1);

      await act(async () => {
        deferredMutator.resolve("new-value");
      });

      expect(status).toBe(MutationStatus.RESOLVED);

      expect(client.get([stringKey])).toBe("new-value");
      expect(client.get([numberKey])).toBe(1);

      expect(lastRenderedValue).toBe("new-value");
      expect(renderCount).toBe(3);
    });

    it("should rollback the provided update caches on a failed mutation with an optimistic update", async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      client.set("1", [stringKey]);
      client.set(1, [numberKey]);

      function Component(): any {
        let result = client.useMutation(
          [[stringKey], [numberKey]],
          () => deferredMutator.promise,
          {
            updates: [[stringKey]],
            optimisticData: "optimistic",
          }
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!().catch(() => {});
      });

      expect(status).toBe(MutationStatus.PENDING);

      expect(client.get([stringKey])).toBe("optimistic");
      expect(client.get([numberKey])).toBe(1);

      await act(async () => {
        deferredMutator.reject("rejected");
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(client.get([stringKey])).toBe("1");
      expect(client.get([numberKey])).toBe(1);
    });

    it("should invalidate instead of rollback the provided caches with an optimistic update on a failed mutation if the original status was not resolved", async () => {
      const promise = client.get([stringKey]);

      pendingDeferred[0]!.reject("rejected");
      await (promise as Promise<any>).catch(() => {});

      expect(client.getStatus([stringKey])).toBe(CacheStatus.REJECTED);

      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      function Component(): any {
        let result = client.useMutation(
          [[stringKey]],
          () => deferredMutator.promise,
          {
            updates: [[stringKey]],
            optimisticData: "optimistic",
          }
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      await mount(<Component />);

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!().catch(() => {});
      });

      expect(status).toBe(MutationStatus.PENDING);
      expect(client.getStatus([stringKey])).toBe(CacheStatus.RESOLVED);

      await act(async () => {
        deferredMutator.reject("rejected");
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(client.getStatus([stringKey])).toBe(CacheStatus.REVALIDATING);
    });
  });

  describe("CacheOptionsProvider", () => {
    let load = vi.fn(async () => "value");
    let onError = vi.fn();
    let onSuccess = vi.fn();
    let getCache = vi.fn(() => new Map());
    let client = new CacheClient({
      primer: {
        key: {
          load,
        },
      },
      onError,
      onSuccess,
      getCache,
    });

    async function mount(component: React.ReactNode) {
      container = document.createElement("div");
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <CacheProvider client={client}>
            <ErrorBoundary
              onError={(e) => {
                lastThrownError = e;
                console.log(e);
              }}
            >
              {component}
            </ErrorBoundary>
          </CacheProvider>
        );
      });
    }

    function Suspender() {
      suspenseCount++;
      return null;
    }

    function Component() {
      const value = client.suspend<string, [string]>(["key"]);

      return <div>{value}</div>;
    }

    beforeEach(() => {
      load = vi.fn(async () => "value");
      onError = vi.fn();
      onSuccess = vi.fn();
      getCache = vi.fn(() => new Map());
      client = new CacheClient({
        primer: {
          key: {
            load,
          },
        },
        onError,
        onSuccess,
        getCache,
      });
    });
    it("should provide the cache options, overriding the default ones", async () => {
      let ownLoad = vi.fn(async () => "ownValue");
      let ownOnError = vi.fn();
      let ownOnSuccess = vi.fn();
      let ownGetCache = vi.fn(() => new Map());

      await mount(
        <CacheOptionsProvider
          options={{
            onError: ownOnError,
            onSuccess: ownOnSuccess,
            getCache: ownGetCache,
            primer: {
              key: {
                load: ownLoad,
              },
            },
          }}
        >
          <React.Suspense fallback={<Suspender />}>
            <Component />
          </React.Suspense>
        </CacheOptionsProvider>
      );

      expect(load).not.toHaveBeenCalled();
      expect(ownLoad).toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
      expect(ownOnError).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
      expect(ownOnSuccess).toHaveBeenCalled();
      expect(ownGetCache).toHaveBeenCalled();
    });
  });
});
