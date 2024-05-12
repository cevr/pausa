/* eslint-disable no-underscore-dangle */
/* eslint-disable react-hooks/exhaustive-deps */
/* eslint-disable react-hooks/rules-of-hooks */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as React from "react";

import { replaceEqualDeep } from "./internals.js";
import { CacheRecord, CacheResultStatus, CacheStatus } from "./types.js";
import type {
  CacheLoadContext,
  CacheMap,
  CacheValueResult,
  GetLoadParameters,
  Mutation,
  PendingCacheRecord,
  Resource,
  ResourceParams,
  ResourceValues,
  SuspenseCacheEvent,
  SuspenseCacheOptions,
  UnsubscribeFromCacheStatusFunction,
} from "./types.js";
import { makeKey } from "./utils.js";

export class SuspenseCache<TParams extends any[], TValue> {
  private recordMap: CacheMap<string, CacheRecord<TValue>>;
  // this is used to store the args for a given cache key after a load has been triggered
  // to be used when invalidateAll is called
  // it will be synced with the recordCache when a record is evicted so that it doesn't grow unbounded
  private reverseKeyMap: Map<string, TParams> = new Map();
  private subscribers = new Set<
    (args: TParams, status: CacheStatus | null) => void
  >();

  // the mutation map keeps track of all the mutations that are currently in flight
  // it's used to prevent the cache from being overwritten by a stale mutation
  // so latest mutations are always the ones that are applied
  private mutationMap = new Map<string, AbortController>();

  private eventLog: SuspenseCacheEvent[] = [];

  logEvent: (event: SuspenseCacheEvent) => void;

  options: SuspenseCacheOptions<TParams, TValue>;

  constructor(options: SuspenseCacheOptions<TParams, TValue>) {
    this.recordMap = options.getCache(this.onExternalEviction);
    this.options = options;
    this.logEvent = (event: SuspenseCacheEvent) => {
      if (this.options.debug) {
        // eslint-disable-next-line no-console
        console.log(this.options.name ?? this.options.load.name, event);

        if (this.options.devtools) {
          this.eventLog.push(event);
        }
      }
    };
  }

  // this is called if the cache eviction policy is not controlled by this cache (provided by the getCache option)
  private onExternalEviction = (key: string): void => {
    const args = this.reverseKeyMap.get(key);
    this.reverseKeyMap.delete(key);
    this.logEvent({
      type: "evict",
      key,
      args: args as any,
    });
    // const subscribers = this.subscriberMap.get(key);
    if (args) {
      React.startTransition(() => {
        this.subscribers.forEach((sub) => sub(args, null));
      });
    }
  };

  private getOrCreateRecord(args: TParams): CacheRecord<TValue> {
    const cacheKey = this.options.getKey(args);

    let record = this.recordMap.get(cacheKey);

    if (!record) {
      record = CacheRecord.makePending();

      this.logEvent({
        type: "pending",
        key: cacheKey,
        args,
      });

      this.recordMap.set(cacheKey, record);

      this.notifySubscribers(args, record);

      this.loadValue(cacheKey, record, ...args);
    }
    if (CacheRecord.isResolved(record)) {
      const now = Date.now();
      const ttl =
        (this.options.ttl instanceof Function
          ? this.options.ttl(args, record.data.value)
          : this.options.ttl) ?? Infinity;
      if (ttl === 0 || now - record.data.createdAt > ttl) {
        this.invalidate(...args);
      }
    }

    return record;
  }

  private async loadValue(
    cacheKey: string,
    record: PendingCacheRecord<TValue>,
    ...args: TParams
  ): Promise<void> {
    this.reverseKeyMap.set(cacheKey, args);
    const signal = record.data.controller.signal;
    const promise = this.options
      .load(record.data.controller, ...args)
      .then((v) => {
        if (record.data.lastValue) {
          return replaceEqualDeep(record.data.lastValue, v);
        }
        return v;
      });
    try {
      const value = await promise;

      if (!signal.aborted) {
        CacheRecord.resolve(
          record,
          value,
          // react `use` hooks expect a promise at all times
          // so we just store the resolved promise at all times
          promise
        );
        this.logEvent({
          type: "resolve",
          key: cacheKey,
          args,
          value,
        });
        this.options.onSuccess?.(args, value);
        this.notifySubscribers(args, record);
      }
    } catch (error) {
      if (!signal.aborted) {
        CacheRecord.reject(record, error, promise);
        this.logEvent({
          type: "reject",
          key: cacheKey,
          args,
          error,
        });
        this.options.onError?.(args, error);
        this.notifySubscribers(args, record);
      }
    }
  }

  private notifySubscribers(
    args: TParams,
    record: CacheRecord<TValue> | null
  ): void {
    React.startTransition(() => {
      this.subscribers.forEach((subscriber) =>
        subscriber(args, record?.data?.status ?? null)
      );
    });
  }

  /**
   * Will alert the cache that the value for the given args is no longer valid.
   * If the cache entry is resolved or rejected, it will attempt to re-fetch the value.
   * If the cache entry does not exist, it will be created.
   */
  invalidate<Key extends TParams>(...args: Key): Promise<TValue> {
    const cacheKey = this.options.getKey(args);
    let record = this.recordMap.get(cacheKey);
    if (record) {
      this.logEvent({
        type: "invalidate",
        key: cacheKey,
        args,
      });

      if (CacheRecord.isPending(record)) {
        // abort but do not delete the record
        this.logEvent({
          type: "abort",
          key: cacheKey,
          args,
        });
        record.data.controller.abort();
      }

      CacheRecord.pend(record);

      this.notifySubscribers(args, record);

      this.loadValue(cacheKey, record, ...args);
    } else {
      this.getOrCreateRecord(args);
    }
    return this.get(...args);
  }

  private invalidateBatch(keys: TParams[]): void {
    let records: [TParams, CacheRecord<TValue>][] = [];
    keys.forEach((args) => {
      const cacheKey = this.options.getKey(args);
      let record = this.recordMap.get(cacheKey);
      if (record) {
        if (CacheRecord.isPending(record)) {
          record.data.controller.abort();
        }
        CacheRecord.pend(record);
        this.loadValue(cacheKey, record, ...args);
      } else {
        record = this.getOrCreateRecord(args);
      }
      records.push([args, record]);
    });
    records.forEach(([args, record]) => {
      this.notifySubscribers(args, record);
    });
  }

  invalidateAll(): void {
    const keys = Array.from(this.reverseKeyMap.values());
    this.invalidateBatch(keys);
  }

  invalidateMatching(predicate: (args: TParams) => boolean): void {
    let keysToInvalidate: TParams[] = [];
    this.reverseKeyMap.forEach((args) => {
      if (predicate(args)) {
        keysToInvalidate.push(args);
      }
    });
    this.invalidateBatch(keysToInvalidate);
  }

  peek<Key extends TParams>(...args: Key): TValue | undefined {
    const cacheKey = this.options.getKey(args);
    const record = this.recordMap.get(cacheKey);

    if (CacheRecord.isResolved(record)) {
      return record.data.value;
    }

    if (CacheRecord.isRejected(record)) {
      throw record.data.error;
    }
    if (record?.data.lastValue) {
      return record.data.lastValue;
    }
  }

  /**
   * Attempts to get the status of the cache entry for the given args.
   * Will return undefined if the cache entry does not exist.
   */
  getStatus<Key extends TParams>(...args: Key): CacheStatus | undefined {
    const cacheKey = this.options.getKey(args);
    const status = this.recordMap.get(cacheKey)?.data.status;

    return status;
  }

  subscribe(
    callback: (args: TParams, status: CacheStatus | null) => void
  ): UnsubscribeFromCacheStatusFunction;
  subscribe<Key extends TParams>(
    args: Key,
    callback: (status: CacheStatus | null) => void
  ): UnsubscribeFromCacheStatusFunction;
  subscribe<Key extends TParams>(
    maybeArgs: Key | ((args: TParams, status: CacheStatus | null) => void),
    callback?: (status: CacheStatus | null) => void
  ): UnsubscribeFromCacheStatusFunction {
    if (maybeArgs instanceof Function) {
      this.subscribers.add(maybeArgs);
      return () => {
        this.subscribers.delete(maybeArgs);
      };
    }

    const listenKey = this.options.getKey(maybeArgs);

    const cb = (args: TParams, status: CacheStatus | null): void => {
      const updatedKey = this.options.getKey(args);

      if (updatedKey === listenKey) {
        callback!(status);
      }
    };

    this.subscribers.add(cb);

    return () => {
      this.subscribers.delete(cb);
    };
  }

  get<Key extends TParams>(...args: Key): Promise<TValue> {
    const record = this.getOrCreateRecord(args);

    if (CacheRecord.isPending(record)) {
      return record.data.value.promise;
    }

    if (CacheRecord.isResolved(record)) {
      return record.data.promise;
    }

    return record.data.promise;
  }

  /**
   * Sets the cache entry for the given args to the given value.
   * This will not attempt to re-fetch the value.
   * This will not invalidate any other cache entries.
   */
  set(
    value: TParams extends [any, ...any[]]
      ? "Set shorthand is only supported for no-arg caches"
      : TValue
  ): void;
  set<Key extends TParams>(key: Key, value: TValue): void;
  set<Key extends TParams>(keyOrValue: Key | TValue, value?: TValue): void {
    if (value === undefined) {
      value = keyOrValue as TValue;
    }
    const key = Array.isArray(keyOrValue) ? keyOrValue : ([] as unknown as Key);
    const cacheKey = this.options.getKey(key);
    let currentRecord = this.recordMap.get(cacheKey);
    if (currentRecord && CacheRecord.isPending(currentRecord)) {
      currentRecord.data.controller.abort();
    }
    let nextValue = value;

    if (CacheRecord.isResolved(currentRecord)) {
      nextValue = replaceEqualDeep(currentRecord.data.value, value);
    } else if (
      CacheRecord.isPending(currentRecord) &&
      currentRecord.data.lastValue
    ) {
      nextValue = replaceEqualDeep(currentRecord.data.lastValue, value);
    }

    if (!currentRecord) {
      currentRecord = CacheRecord.makeResolved(nextValue);
      this.recordMap.set(cacheKey, currentRecord);
    } else {
      CacheRecord.resolve(currentRecord, nextValue, Promise.resolve(nextValue));
    }

    this.logEvent({
      type: "set",
      key: cacheKey,
      args: key,
      lastValue: currentRecord.data?.value,
      value: nextValue,
    });

    this.reverseKeyMap.set(cacheKey, key);
    // we want to wrap this in a transition so React's minimum suspense duration heurestics are skipped
    // this would happen if we set a value that was pending and then immediately read it
    this.notifySubscribers(key, currentRecord);
  }

  has<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(args);
    return this.recordMap.has(cacheKey);
  }

  /**
   * Clears the entire cache. Will notify subscribers.
   */
  clear(): void {
    this.recordMap.clear();
    this.reverseKeyMap.forEach((args) => {
      this.abort(...args);
      React.startTransition(() => {
        this.subscribers.forEach((sub) => sub(args, null));
      });
    });
    this.reverseKeyMap.clear();
    this.subscribers.clear();
  }

  /**
   * Removes the cache entry for the given args.
   */
  delete<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(args);
    const deleted = this.recordMap.delete(cacheKey);
    this.abort(...args);
    this.reverseKeyMap.delete(cacheKey);
    this.notifySubscribers(args, null);
    return deleted;
  }

  private deleteBatch(keys: TParams[]): void {
    const deletedSet = keys.filter((args) => {
      const cacheKey = this.options.getKey(args);
      const deleted = this.recordMap.delete(cacheKey);
      if (deleted) {
        this.abort(...args);
        this.reverseKeyMap.delete(cacheKey);
      }
      return deleted;
    });
    deletedSet.forEach((args) => {
      this.notifySubscribers(args, null);
    });
  }

  deleteMatching(predicate: (args: TParams) => boolean): void {
    const keysToDelete: TParams[] = [];
    this.reverseKeyMap.forEach((args) => {
      if (predicate(args)) {
        keysToDelete.push(args);
      }
    });
    this.deleteBatch(keysToDelete);
  }

  useStatus<Key extends TParams>(...args: Key): CacheStatus | undefined {
    const cache = this;

    return React.useSyncExternalStore(
      (cb) => cache.subscribe(args, cb),
      () => cache.getStatus(...args)
    );
  }

  private read(args: TParams): TValue {
    const record = this.getOrCreateRecord(args);
    if (CacheRecord.isResolved(record)) {
      return record.data.value;
    }
    if (CacheRecord.isRejected(record)) {
      throw record.data.error;
    }
    if (record.data.lastValue) {
      return record.data.lastValue;
    }
    return React.use(record.data.value.promise);
  }

  /**
   * This attempts to read the cache value and returns the value and a boolean indicating if the value is stale.
   * If the value is not in the cache it will suspend the component until the value is available.
   * If the value is in the cache but is stale it will return the stale value and revalidate the value in the background.
   * If the value errors it will throw the error to the nearest error boundary.
   */
  use<Key extends TParams>(...args: Key): TValue {
    const [value, setValue] = React.useState(() => this.read(args));
    React.useEffect(() => {
      return this.subscribe(args, () => {
        const record = this.getOrCreateRecord(args);
        if (CacheRecord.isResolved(record)) {
          const nextValue = record.data.value;
          if (!Object.is(value, nextValue)) {
            setValue(nextValue);
          }
        }
        if (CacheRecord.isRejected(record)) {
          throw record.data.error;
        }
      });
    }, args);
    return value;
  }

  /**
   * This hook is the same as use, but will skip transitions
   */
  useSynced<Key extends TParams>(...args: Key): TValue {
    return React.useSyncExternalStore(
      (cb) => this.subscribe(args, cb),
      () => this.read(args)
    );
  }

  /**
   * This will prime the cache with a value that will be read elsewhere.
   */
  preload<Key extends TParams>(...args: Key): void {
    const record = this.getOrCreateRecord(args);
    if (CacheRecord.isRejected(record)) {
      this.invalidate(...args);
    }
    // otherwise the record is already pending or resolved and we don't need to do anything
  }

  abort<Key extends TParams>(...args: Key): boolean {
    const cacheKey = this.options.getKey(args);
    const record = this.recordMap.get(cacheKey);
    if (CacheRecord.isPending(record)) {
      record.data.controller.abort();
      return this.delete(...args);
    }
    return false;
  }

  useSelector<Key extends TParams, TSelected>(
    key: Key,
    selector: (value: TValue) => TSelected
  ): TSelected {
    const [value, setValue] = React.useState<TSelected>(() => {
      const record = this.getOrCreateRecord(key);
      if (CacheRecord.isResolved(record)) {
        return selector(record.data.value);
      }
      if (CacheRecord.isRejected(record)) {
        throw record.data.error;
      }
      if (record.data.lastValue) {
        return selector(record.data.lastValue);
      }
      const value = React.use(record.data.value.promise);
      const nextValue = selector(value);
      return nextValue;
    });

    React.useEffect(() => {
      return this.subscribe(key, () => {
        const record = this.getOrCreateRecord(key);
        if (CacheRecord.isResolved(record)) {
          const nextValue = selector(record.data.value);
          if (!Object.is(value, nextValue)) {
            setValue(nextValue);
          }
        }
        if (CacheRecord.isRejected(record)) {
          throw record.data.error;
        }
      });
    }, [key]);
    return value;
  }

  useSyncedSelector<Key extends TParams, TSelected>(
    key: Key,
    selector: (value: TValue) => TSelected
  ): TSelected {
    const boundSelector = React.useCallback(() => {
      return selector(this.read(key));
    }, [key, selector]);
    return React.useSyncExternalStore(
      React.useCallback((cb) => this.subscribe(key, cb), [key]),
      boundSelector,
      boundSelector
    );
  }

  async mutate<
    Key extends TParams,
    Res extends TValue | undefined | null | void
  >(
    key: Key,
    mutator: (opts: { signal: AbortSignal }) => Promise<Res>,
    options?: {
      optimisticData?: TValue;
      onError?: (error: unknown) => void;
      onSuccess?: (value: Res) => void;
    }
  ): Promise<Res | void> {
    const cache = this;

    const keyString = this.options.getKey(key);
    const currentMutation = this.mutationMap.get(keyString);
    if (currentMutation) {
      currentMutation.abort();
    }
    const controller = new AbortController();
    this.mutationMap.set(keyString, controller);

    if (options?.optimisticData) {
      cache.set(key, options?.optimisticData);
    }
    return mutator({ signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) {
          if (res !== null && res !== undefined) {
            cache.set(key, res as TValue);
          } else {
            cache.invalidate(...key);
          }
          options?.onSuccess?.(res);
          this.mutationMap.delete(keyString);
          return res;
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          cache.invalidate(...key);
          options?.onError?.(err);
          this.mutationMap.delete(keyString);
          throw err;
        }
      });
  }

  useMutation<
    MutationParams extends any[],
    Res extends TValue | undefined | null | void
  >(
    key: TParams,
    mutator: (
      {
        signal,
      }: {
        signal: AbortSignal;
      },
      ...args: MutationParams
    ) => Promise<Res>,
    options?: {
      optimisticData?: TValue | ((...args: MutationParams) => TValue);
      onError?: (error: unknown, ...args: MutationParams) => void;
      onSuccess?: (value: Res, ...args: MutationParams) => void;
      resetDelay?: number;
    }
  ): Mutation<(...args: MutationParams) => Promise<Res | void>> {
    const cache = this;
    const [isPending, setIsPending] = React.useState(false);

    const trigger = React.useCallback(
      async (...args: MutationParams) => {
        setIsPending(true);
        return cache
          .mutate(key, (opts) => mutator(opts, ...args), {
            optimisticData:
              options?.optimisticData instanceof Function
                ? options.optimisticData(...args)
                : options?.optimisticData,
            onError: (error) => options?.onError?.(error, ...args),
            onSuccess: (value) => options?.onSuccess?.(value, ...args),
          })
          .finally(() => {
            setIsPending(false);
          });
      },
      [mutator, options, setIsPending, key, cache]
    );
    return React.useMemo(() => [trigger, isPending], [trigger, isPending]);
  }

  useImperativeValue(...args: TParams): CacheValueResult<TValue> {
    const record = React.useSyncExternalStore(
      (cb) => this.subscribe(args, cb),
      () => this.getOrCreateRecord(args).data
    );
    if (record.status === CacheStatus.PENDING) {
      return record.lastValue !== undefined
        ? [CacheResultStatus.REVALIDATING, record.lastValue]
        : [CacheResultStatus.PENDING, undefined];
    }

    if (record.status === CacheStatus.REJECTED) {
      return [CacheResultStatus.REJECTED, record.error];
    }

    return [CacheResultStatus.RESOLVED, record.value];
  }

  logs(): SuspenseCacheEvent[] {
    return this.eventLog;
  }

  records(): CacheMap<string, CacheRecord<TValue>> {
    return this.recordMap;
  }
}

export function cache<TParams extends any[] = [], TValue = unknown>(
  load: (
    cacheLoadContext: CacheLoadContext,
    ...args: TParams
  ) => Promise<TValue>,
  options?: Partial<Omit<SuspenseCacheOptions<TParams, TValue>, "load">>
): SuspenseCache<TParams, TValue> {
  const name = options?.name ?? `cache(${load.name})`;
  let c = new SuspenseCache({
    getKey: makeKey,
    getCache: () => new Map(),
    debug: false,
    ...options,
    name,
    load,
  });

  return c;
}

// this is a type that overrides the SuspenseCache while keeping the same interface
// it's used so we can make caches that have variadic load functions
export interface SuspenseResourceCache<
  TResource extends Resource,
  TResourceParams extends ResourceParams<TResource> = ResourceParams<TResource>,
  TResourceValues extends ResourceValues<TResource> = ResourceValues<TResource>
> extends SuspenseCache<any, TResourceValues[keyof TResourceValues]> {
  invalidate<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): Promise<TResourceValues[TResourceKey]>;
  invalidateAll(): void;
  invalidateMatching(
    predicate: <TResourceKey extends keyof TResource>(
      args: [TResourceKey, ...TResourceParams[TResourceKey]]
    ) => boolean
  ): void;

  peek<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): TResourceValues[TResourceKey] | undefined;

  getStatus<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheStatus;

  subscribe<TResourceKey extends keyof TResource>(
    cb: (
      args: [TResourceKey, ...TResourceParams[TResourceKey]],
      status: CacheStatus | null
    ) => void
  ): UnsubscribeFromCacheStatusFunction;
  subscribe<TResourceKey extends keyof TResource>(
    key: [TResourceKey, ...TResourceParams[TResourceKey]],
    cb: (status: CacheStatus | null) => void
  ): UnsubscribeFromCacheStatusFunction;

  useSubscription<TResourceKey extends keyof TResource>(
    key: [TResourceKey, ...TResourceParams[TResourceKey]]
  ): CacheRecord<TResourceValues[TResourceKey]>;

  get<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): Promise<TResourceValues[TResourceKey]>;

  set(value: never): void;
  set<TResourceKey extends keyof TResource>(
    key: [TResourceKey, ...TResourceParams[TResourceKey]],
    value: TResourceValues[TResourceKey]
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

  deleteMatching<TResourceKey extends keyof TResource>(
    predicate: (
      args: [TResourceKey, ...TResourceParams[TResourceKey]]
    ) => boolean
  ): void;

  useImperativeValue<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheValueResult<TResourceValues[TResourceKey]>;

  useStatus<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): CacheStatus;

  use<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): TResourceValues[TResourceKey];

  useSynced<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): TResourceValues[TResourceKey];

  preload<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): void;

  abort<TResourceKey extends keyof TResource>(
    key: TResourceKey,
    ...args: TResourceParams[TResourceKey]
  ): boolean;

  useSelector<TResourceKey extends keyof TResource, TSelected>(
    key: [TResourceKey, ...TResourceParams[TResourceKey]],
    selector: (value: TResourceValues[TResourceKey]) => TSelected
  ): TSelected;

  mutate<
    TResourceKey extends keyof TResource,
    Res extends TResourceValues[TResourceKey] | undefined | null | void
  >(
    key: [TResourceKey, ...TResourceParams[TResourceKey]],
    mutator: (opts: { signal: AbortSignal }) => Promise<Res>,
    options?: {
      optimisticData?: TResourceValues[TResourceKey];
      onError?: (error: unknown) => void;
      onSuccess?: (value: Res) => void;
    }
  ): Promise<Res>;

  useMutation<
    TResourceKey extends keyof TResource,
    MutationParams extends any[],
    Res extends TResourceValues[TResourceKey] | undefined | null | void
  >(
    keys: [TResourceKey, ...TResourceParams[TResourceKey]],
    mutator: (
      { signal }: { signal: AbortSignal },
      ...args: MutationParams
    ) => Promise<Res>,
    options?: {
      optimisticData?:
        | TResourceValues[TResourceKey]
        | ((...args: MutationParams) => TResourceValues[TResourceKey]);
      onError?: (error: unknown, ...args: MutationParams) => void;
      onSuccess?: (value: Res, ...args: MutationParams) => void;
      resetDelay?: number;
    }
  ): Mutation<(...args: MutationParams) => Promise<Res>>;
}

export function cacheResource<
  TResource extends Resource,
  TResourceParams extends {
    [key in keyof TResource]: GetLoadParameters<TResource[key]>;
  } = {
    [key in keyof TResource]: GetLoadParameters<TResource[key]>;
  },
  TResourceErrors extends {
    [key in keyof TResource]: any;
  } = {
    [key in keyof TResource]: unknown;
  },
  TResourceValues extends {
    [key in keyof TResource]: Awaited<ReturnType<TResource[key]>>;
  } = {
    [key in keyof TResource]: Awaited<ReturnType<TResource[key]>>;
  }
>(
  resource: TResource,
  options?: Partial<
    Omit<
      SuspenseCacheOptions<
        TResourceParams[keyof TResource],
        TResourceValues[keyof TResource]
      >,
      "load" | "getKey" | "onError" | "onSuccess"
    > & {
      getKey: (
        args: [keyof TResource, ...TResourceParams[keyof TResource]]
      ) => string;
      init?: {
        [key in keyof TResource]?: TResourceValues[key];
      };
      onError?: (
        args: [keyof TResource, ...TResourceParams[keyof TResource]],
        error: TResourceErrors[keyof TResource]
      ) => void;
      onSuccess?: (
        args: [keyof TResource, ...TResourceParams[keyof TResource]],
        value: TResourceValues[keyof TResource]
      ) => void;
    }
  >
): SuspenseResourceCache<TResource, TResourceParams, TResourceValues> {
  const name = options?.name ?? `resource(${Object.keys(resource).join(":")})`;

  const suspenseCache = new SuspenseCache<
    [keyof TResource, ...TResourceParams[keyof TResource]],
    TResourceValues[keyof TResource]
  >({
    getCache: () => new Map(),
    debug: false,
    getKey: makeKey,
    ...(options as any),
    name,
    load: (cacheLoadContext, ...args) => {
      const [method, ...rest] = args;
      return resource[method](cacheLoadContext, ...rest);
    },
  }) as SuspenseResourceCache<TResource, TResourceParams, TResourceValues>;

  return suspenseCache;
}

type IncludedStoreKeys =
  | "peek"
  | "getStatus"
  | "subscribe"
  | "get"
  | "set"
  | "has"
  | "clear"
  | "delete"
  | "use"
  | "useSynced"
  | "useStatus"
  | "useSelector";

export interface SuspenseStore<TValue>
  extends Pick<SuspenseCache<[], TValue>, IncludedStoreKeys> {}

export interface SuspenseResourceStore<TValue extends Record<string, any>>
  extends Pick<
    SuspenseResourceCache<{
      [Key in keyof TValue]: () => Promise<TValue[Key]>;
    }>,
    IncludedStoreKeys
  > {}

export function store<TValue>(
  options?: Partial<Omit<SuspenseCacheOptions<[], TValue>, "load" | "getKey">>
): SuspenseStore<TValue> {
  return cache(() => new Promise<TValue>(() => {}), options) as any;
}

export function resourceStore<TValue extends Record<string, any>>(
  options?: Partial<
    Omit<
      SuspenseCacheOptions<[keyof TValue], TValue[keyof TValue]>,
      "load" | "getKey"
    >
  >
): SuspenseResourceStore<TValue> {
  return cache(() => new Promise<TValue>(() => {}), options as any) as any;
}
