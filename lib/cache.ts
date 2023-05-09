/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as React from "react";

import { useForceUpdate } from "./hooks";
import { CacheRecord, CacheStatus } from "./types";
import type {
  CacheLoadContext,
  CacheMap,
  CacheValueResult,
  PendingCacheRecord,
  Resource,
  ResourceParameters,
  RevalidatingCacheRecord,
  SubscribeCallback,
  SuspenseCacheOptions,
  UnsubscribeFromCacheStatusFunction,
} from "./types";
import { cacheKeyDelimiter, isPromiseLike } from "./utils";

// this acts as a cache for the results of the fetchValue function
// with the key being the args passed to the fetchValue function
export class SuspenseCache<
  TParams extends any[] = any[],
  TError = unknown,
  TValue = unknown
> {
  private recordCache: CacheMap<string, CacheRecord<TError, TValue>>;
  // this is used to store the args for a given cache key after a load has been triggered
  // to be used when invalidateAll is called
  // it will be synced with the recordCache when a record is evicted so that it doesn't grow unbounded
  private invalidationArgs: Map<string, TParams> = new Map();

  private subscriberMap = new Map<string, Set<SubscribeCallback>>();

  debugLog: (...args: any[]) => void;

  constructor(private options: SuspenseCacheOptions<TParams, TError, TValue>) {
    this.recordCache = this.options.getCache(this.onExternalEviction);
    this.debugLog = (...args: any[]) => {
      if (this.options.debug) {
        // eslint-disable-next-line no-console
        console.log(
          `SuspenseCache(${this.options.debugLabel ?? this.options.load.name})`,
          ...args
        );
      }
    };
  }

  // this is called if the cache eviction policy is not controlled by this cache (provided by the getCache option)
  private onExternalEviction = (key: string): void => {
    this.invalidationArgs.delete(key);
    const subscribers = this.subscriberMap.get(key);
    if (subscribers) {
      subscribers.forEach((subscriber) => subscriber(CacheStatus.MISSING));
    }
  };

  private getOrCreateRecord(...args: TParams): CacheRecord<TError, TValue> {
    const cacheKey = this.options.getKey(...args);

    let record = this.recordCache.get(cacheKey);

    if (!record) {
      record = CacheRecord.makePending();

      this.debugLog("getOrCreateRecord():: record created", {
        cacheKey,
        record,
      });

      this.recordCache.set(cacheKey, record);

      this.notifySubscribers(cacheKey);

      this.loadValue(cacheKey, record, ...args);
    } else {
      this.debugLog("getOrCreateRecord():: record returned", {
        cacheKey,
        record,
      });
    }

    return record;
  }

  private async loadValue(
    cacheKey: string,
    record:
      | PendingCacheRecord<TError, TValue>
      | RevalidatingCacheRecord<TError, TValue>,
    ...args: TParams
  ): Promise<void> {
    this.invalidationArgs.set(cacheKey, args);
    const signal = record.data.controller.signal;
    try {
      const valueOrPromise = this.options.load(record.data.controller, ...args);
      const value = isPromiseLike(valueOrPromise)
        ? await valueOrPromise
        : valueOrPromise;
      this.debugLog("loadValue():: value resolved", {
        value,
        record,
        aborted: signal.aborted,
      });

      if (!signal.aborted) {
        this.options.onSuccess?.(value);
        CacheRecord.resolve(record, value);
        this.debugLog("loadValue():: record resolved", { record });
      }
    } catch (error) {
      if (!signal.aborted) {
        this.options.onError?.(error as TError);
        CacheRecord.reject(record, error as TError);
        this.debugLog("loadValue():: record rejected", { record });
      }
    } finally {
      if (!signal.aborted) {
        this.debugLog("loadValue():: notifying subscribers");
        this.notifySubscribers(cacheKey);
      }
    }
  }

  private notifySubscribers(cacheKey: string): void {
    const subscribers = this.subscriberMap.get(cacheKey);
    if (subscribers) {
      const status = this.getStatusInternal(cacheKey);
      subscribers.forEach((subscriber) => subscriber(status));
    }
  }

  // this is used by our private methods so to not calculate the cacheKey more than once
  private getStatusInternal(cacheKey: string): CacheStatus {
    const record = this.recordCache.get(cacheKey);
    const status = record?.data.status ?? CacheStatus.MISSING;
    return status;
  }

  /**
   * Will alert the cache that the value for the given args is no longer valid.
   * If the cache entry is resolved or rejected, it will attempt to re-fetch the value.
   * If the cache entry does not exist, it will be created.
   */
  invalidate<Key extends TParams>(...args: Key): void {
    const cacheKey = this.options.getKey(...args);
    let record = this.recordCache.get(cacheKey);
    if (record) {
      this.debugLog("invalidate():: record found", { cacheKey, record });
      if (CacheRecord.isPending(record) || CacheRecord.isRevalidating(record)) {
        this.debugLog("invalidate():: aborting", { cacheKey, record });
        record.data.controller.abort();
      }

      if (
        CacheRecord.isResolved(record) ||
        CacheRecord.isRevalidating(record)
      ) {
        this.debugLog("invalidate():: transitioning to revalidating", {
          cacheKey,
          record,
        });
        CacheRecord.revalidate(record);
      } else {
        this.debugLog("invalidate():: transitioning to pending", {
          cacheKey,
          record,
        });
        CacheRecord.pend(record);
      }

      this.notifySubscribers(cacheKey);

      this.loadValue(cacheKey, record, ...args);
    } else {
      this.getOrCreateRecord(...args);
    }
  }

  invalidateAll(): void {
    this.recordCache.forEach((record, cacheKey) => {
      const args = this.invalidationArgs.get(cacheKey);
      if (args) {
        this.debugLog("invalidateAll():: record found", { cacheKey, record });
        if (
          CacheRecord.isPending(record) ||
          CacheRecord.isRevalidating(record)
        ) {
          this.debugLog("invalidateAll():: aborting", { cacheKey, record });
          record.data.controller.abort();
        }

        if (
          CacheRecord.isResolved(record) ||
          CacheRecord.isRevalidating(record)
        ) {
          this.debugLog("invalidateAll():: transitioning to revalidating", {
            cacheKey,
            record,
          });
          CacheRecord.revalidate(record);
        } else {
          this.debugLog("invalidateAll():: transitioning to pending", {
            cacheKey,
            record,
          });
          CacheRecord.pend(record);
        }

        this.notifySubscribers(cacheKey);

        this.loadValue(cacheKey, record, ...args);
      }
    });
  }

  peek<Key extends TParams>(...args: Key): TValue | undefined {
    const cacheKey = this.options.getKey(...args);
    const record = this.recordCache.get(cacheKey);

    this.debugLog("peek()::", { cacheKey, record });

    if (record) {
      if (CacheRecord.isResolved(record)) {
        return record.data.value;
      }

      if (CacheRecord.isRevalidating(record)) {
        return record.data.cached;
      }

      if (CacheRecord.isRejected(record)) {
        throw record.data.error;
      }
    }
  }

  /**
   * Attempts to get the status of the cache entry for the given args.
   * Will return undefined if the cache entry does not exist.
   */
  getStatus<Key extends TParams>(...args: Key): CacheStatus {
    const cacheKey = this.options.getKey(...args);
    const status = this.getStatusInternal(cacheKey);
    this.debugLog("getStatus()::", { cacheKey, status });
    return status;
  }

  subscribeToStatus<Key extends TParams>(
    callback: SubscribeCallback,
    ...args: Key
  ): UnsubscribeFromCacheStatusFunction {
    const cacheKey = this.options.getKey(...args);
    let set = this.subscriberMap.get(cacheKey);
    if (set) {
      set.add(callback);
    } else {
      set = new Set([callback]);
      this.subscriberMap.set(cacheKey, set);
    }

    return () => {
      set!.delete(callback);
      if (set!.size === 0) {
        this.subscriberMap.delete(cacheKey);
      }
    };
  }

  get<Key extends TParams>(...args: Key): PromiseLike<TValue> | TValue {
    const record = this.getOrCreateRecord(...args);
    this.debugLog("get()::", { args, record });
    if (CacheRecord.isPending(record)) {
      return record.data.value.promise;
    }
    if (CacheRecord.isRevalidating(record)) {
      return record.data.cached;
    }
    if (CacheRecord.isResolved(record)) {
      return record.data.value;
    }

    throw record.data.error;
  }

  /**
   * Sets the cache entry for the given args to the given value.
   * This will not trigger any subscribers.
   * This will not attempt to re-fetch the value.
   * This will not invalidate any other cache entries.
   */
  set<Key extends TParams>(value: TValue, ...args: Key): void {
    const cacheKey = this.options.getKey(...args);
    this.debugLog("set():: creating", { cacheKey, value });
    this.recordCache.set(cacheKey, CacheRecord.makeResolved(value));
    this.invalidationArgs.set(cacheKey, args);
    this.notifySubscribers(cacheKey);
  }

  has<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(...args);
    return this.recordCache.has(cacheKey);
  }

  /**
   * Clears the entire cache. Will notify subscribers.
   */
  clear(): void {
    this.recordCache.clear();
    this.invalidationArgs.clear();
    this.subscriberMap.forEach((set) =>
      set.forEach((subscriber) => subscriber(CacheStatus.MISSING))
    );
  }

  /**
   * Removes the cache entry for the given args.
   */
  delete<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(...args);
    const deleted = this.recordCache.delete(cacheKey);
    if (deleted) {
      this.invalidationArgs.delete(cacheKey);
      this.notifySubscribers(cacheKey);
    }
    return deleted;
  }

  deleteIf<Key extends TParams>(
    predicate: (value: CacheStatus) => boolean,
    ...args: Key
  ): boolean {
    if (predicate(this.getStatus(...args))) {
      return this.delete(...args);
    }
    return false;
  }

  // this will suspend if the value is not yet resolved
  // so it will always return a value or throw to the nearest error boundary
  suspend<Key extends TParams>(...args: Key): TValue {
    const record = this.getOrCreateRecord(...args);
    if (CacheRecord.isResolved(record)) {
      return record.data.value;
    }

    if (CacheRecord.isRevalidating(record)) {
      return record.data.cached;
    }

    if (CacheRecord.isRejected(record)) {
      throw record.data.error;
    }

    throw record.data.value.promise;
  }

  /**
   * Wraps the cache.get method in a react hook that tracks the status of the cache item
   * and re-renders the component when the status changes.
   * This will not suspend the component nor will it throw an error.
   */
  useValue<Key extends TParams>(
    ...args: Key
  ): CacheValueResult<TError, TValue> {
    const cache = this;
    const status = cache.useStatus(...args);

    React.useEffect(() => {
      if (status === CacheStatus.MISSING) {
        // initiate the fetch if it hasn't already been initiated
        // it is idempotent so it is safe to call multiple times
        cache.get(...args);
      }
    });

    try {
      // typescript can't infer the status type from the value type
      // but the result of peek will match the status type
      const value = cache.peek(...args);
      if (value) {
        return [
          status as
            | typeof CacheStatus.RESOLVED
            | typeof CacheStatus.REVALIDATING,
          value,
        ];
      }
      return [
        status as typeof CacheStatus.MISSING | typeof CacheStatus.PENDING,
        undefined,
      ];
    } catch (err) {
      return [status as typeof CacheStatus.REJECTED, err as TError];
    }
  }

  useStatus<Key extends TParams>(...args: Key): CacheStatus {
    const cache = this;
    const forceUpdate = useForceUpdate();
    const status = cache.getStatus(...args);

    React.useEffect(() => {
      const unsubscribe = cache.subscribeToStatus(forceUpdate, ...args);
      return unsubscribe;
    });

    return status;
  }

  /**
   * This attempts to read the cache value and returns the value and a boolean indicating if the value is stale.
   * If the value is not in the cache it will suspend the component until the value is available.
   * If the value is in the cache but is stale it will return the stale value and revalidate the value in the background.
   * If the value errors it will throw the error to the nearest error boundary.
   */
  read<Key extends TParams>(...args: Key): [TValue, boolean] {
    const cache = this;
    const value = cache.suspend(...args);
    // we use this to track the status of the cache item to know if it needs to be re-rendered
    const status = cache.useStatus(...args);

    return [value, status === CacheStatus.REVALIDATING];
  }

  /**
   * This will prime the cache with a value that will be read elsewhere.
   */
  preload<Key extends TParams>(...args: Key): void {
    this.get(...args);
  }

  abort<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(...args);
    const record = this.recordCache.get(cacheKey);
    if (
      record &&
      (CacheRecord.isPending(record) || CacheRecord.isRevalidating(record))
    ) {
      record.data.controller.abort();
      if (CacheRecord.isPending(record)) {
        return this.delete(...args);
      }

      if (CacheRecord.isRevalidating(record)) {
        this.set(record.data.cached, ...args);
        return true;
      }
    }
    return false;
  }
}

export function cache<TParams extends any[], TError, TValue>(
  load: (
    cacheLoadContext: CacheLoadContext,
    ...args: TParams
  ) => PromiseLike<TValue> | TValue,
  options?: Partial<Omit<SuspenseCacheOptions<TParams, TError, TValue>, "load">>
): SuspenseCache<TParams, TError, TValue> {
  return new SuspenseCache({
    getKey: (...args: TParams) =>
      args.map((x) => JSON.stringify(x)).join(cacheKeyDelimiter),
    getCache: () => new Map(),
    debug: false,
    ...options,
    load,
  });
}

// this is a type that overrides the SuspenseCache while keeping the same interface
// it's used so we can make caches that have variadic load functions
export interface SuspenseResourceCache<
  TResource extends Resource,
  TResourceParams extends {
    [key in keyof TResource]: ResourceParameters<TResource[key]>;
  },
  TResourceErrors extends {
    [key in keyof TResource]: any;
  },
  TResourceValues extends {
    [key in keyof TResource]: Awaited<ReturnType<TResource[key]>>;
  }
> extends SuspenseCache<
    any,
    TResourceErrors[keyof TResource],
    TResourceValues[keyof TResourceValues]
  > {
  invalidate<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): void;

  peek<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): TResourceValues[TResourceKey] | undefined;

  getStatus<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheStatus;

  subscribeToStatus<TResourceKey extends keyof TResource>(
    cb: SubscribeCallback,
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): UnsubscribeFromCacheStatusFunction;

  get<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): PromiseLike<TResourceValues[TResourceKey]> | TResourceValues[TResourceKey];

  set<TResourceKey extends keyof TResource>(
    value: TResourceValues[TResourceKey],
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): void;

  has<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): boolean;

  clear(): void;

  delete<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): boolean;

  deleteIf<TResourceKey extends keyof TResource>(
    predicate: (status: CacheStatus) => boolean,
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): boolean;

  suspend<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): TResourceValues[TResourceKey];

  useValue<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheValueResult<
    TResourceErrors[TResourceKey],
    TResourceValues[TResourceKey]
  >;

  useStatus<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheStatus;

  read<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): [TResourceValues[TResourceKey], boolean];

  preload<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): void;

  abort<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): boolean;
}

export function cacheResource<
  TResource extends Resource,
  TResourceParams extends {
    [key in keyof TResource]: ResourceParameters<TResource[key]>;
  },
  TResourceErrors extends {
    [key in keyof TResource]: any;
  },
  TResourceValues extends {
    [key in keyof TResource]: Awaited<ReturnType<TResource[key]>>;
  }
>(
  resource: TResource,
  options?: Partial<
    Omit<
      SuspenseCacheOptions<
        TResourceParams[keyof TResource],
        TResourceErrors[keyof TResource],
        TResourceValues[keyof TResource]
      >,
      "load" | "getKey"
    > & {
      getKey: {
        [key in keyof TResource]: (...args: TResourceParams[key]) => string;
      };
    }
  >
): SuspenseResourceCache<
  TResource,
  TResourceParams,
  TResourceErrors,
  TResourceValues
> {
  const getKey = options?.getKey;
  return new SuspenseCache<
    [keyof TResource, ...TResourceParams[keyof TResource]],
    TResourceErrors[keyof TResource],
    TResourceValues[keyof TResource]
  >({
    getCache: () => new Map(),
    debug: false,
    debugLabel: `resource(${Object.keys(resource).join(",")})`,
    ...options,
    getKey: (...args) => {
      const [method, ...rest] = args;
      const methodGetKey = getKey?.[method];
      const key = methodGetKey
        ? methodGetKey(...(rest as TResourceParams[keyof TResource]))
        : rest.join(cacheKeyDelimiter);
      return `${
        typeof method !== "string" ? method.toString() : method
      }:${key}`;
    },
    load: (cacheLoadContext, ...args) => {
      const [method, ...rest] = args;
      return resource[method](cacheLoadContext, ...rest);
    },
  }) as SuspenseResourceCache<
    TResource,
    TResourceParams,
    TResourceErrors,
    TResourceValues
  >;
}
