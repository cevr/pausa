import { invariant } from "./internals";
import type { Deferred } from "./utils";
import { defer, DeferredStatus } from "./utils";

export const CacheStatus = {
  ...DeferredStatus,
} as const;

export type CacheStatus = (typeof CacheStatus)[keyof typeof CacheStatus];

export type UnsubscribeFromCacheStatusFunction = () => void;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface ResolvedCacheRecord<TValue> {
  data: {
    status: typeof CacheStatus.RESOLVED;
    value: TValue;
    createdAt: number;
    promise: Promise<TValue>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface RejectedCacheRecord<TValue> {
  data: {
    status: typeof CacheStatus.REJECTED;
    error: unknown;
    promise: Promise<TValue>;
  };
}

export interface PendingCacheRecord<TValue> {
  data: {
    status: typeof CacheStatus.PENDING;
    value: Deferred<TValue>;
    controller: AbortController;
    lastValue?: TValue;
  };
}

export type CacheRecord<TValue> =
  | PendingCacheRecord<TValue>
  | ResolvedCacheRecord<TValue>
  | RejectedCacheRecord<TValue>;

type CacheRecordStatic = {
  makePending<TValue>(): PendingCacheRecord<TValue>;
  makeResolved<TValue>(value: TValue): ResolvedCacheRecord<TValue>;
  makeRejected<TValue>(error: unknown): RejectedCacheRecord<TValue>;
  isPending<TValue>(
    record?: CacheRecord<TValue>
  ): record is PendingCacheRecord<TValue>;
  isResolved<TValue>(
    record?: CacheRecord<TValue>
  ): record is ResolvedCacheRecord<TValue>;
  isRejected<TValue>(
    record?: CacheRecord<TValue>
  ): record is RejectedCacheRecord<TValue>;
  resolve<TValue>(
    record: CacheRecord<TValue>,
    value: TValue,
    promise: Promise<TValue>
  ): asserts record is ResolvedCacheRecord<TValue>;
  reject<TValue>(
    record: CacheRecord<TValue>,
    error: unknown,
    promise: Promise<TValue>
  ): asserts record is RejectedCacheRecord<TValue>;
  pend<TValue>(
    record: CacheRecord<TValue>
  ): asserts record is PendingCacheRecord<TValue>;
};

// this is kept in the type file to take advantage of the type merging
export const CacheRecord: CacheRecordStatic = {
  makePending<TValue>(): PendingCacheRecord<TValue> {
    return {
      data: {
        status: CacheStatus.PENDING,
        value: defer<TValue>(),
        controller: new AbortController(),
      },
    };
  },

  makeResolved<TValue>(value: TValue): ResolvedCacheRecord<TValue> {
    return {
      data: {
        status: CacheStatus.RESOLVED,
        value,
        createdAt: Date.now(),
        promise: Promise.resolve(value),
      },
    };
  },

  makeRejected<TValue>(error: unknown): RejectedCacheRecord<TValue> {
    return {
      data: {
        status: CacheStatus.REJECTED,
        error,
        promise: Promise.reject(error),
      },
    };
  },

  isPending<TValue>(
    record?: CacheRecord<TValue>
  ): record is PendingCacheRecord<TValue> {
    return record?.data.status === CacheStatus.PENDING;
  },

  isResolved<TValue>(
    record?: CacheRecord<TValue>
  ): record is ResolvedCacheRecord<TValue> {
    return record?.data.status === CacheStatus.RESOLVED;
  },

  isRejected<TValue>(
    record?: CacheRecord<TValue>
  ): record is RejectedCacheRecord<TValue> {
    return record?.data.status === CacheStatus.REJECTED;
  },

  resolve<TValue>(
    record: CacheRecord<TValue>,
    value: TValue,
    promise: Promise<TValue>
  ) {
    if (CacheRecord.isResolved(record) || CacheRecord.isRejected(record)) {
      record.data = {
        status: CacheStatus.RESOLVED,
        value,
        promise,
        createdAt: Date.now(),
      };
      return;
    }

    const deferred = record.data.value;
    deferred.resolve(value);
    (record as unknown as ResolvedCacheRecord<TValue>).data = {
      status: CacheStatus.RESOLVED,
      value,
      promise,
      createdAt: Date.now(),
    };
  },

  reject<TValue>(
    record: CacheRecord<TValue>,
    error: unknown,
    promise: Promise<TValue>
  ) {
    invariant(
      CacheRecord.isPending(record),
      "Cannot reject a record that is not pending or revalidating. record is: " +
        record.data.status
    );

    const deferred = record.data.value;
    deferred.reject(error);
    (record as unknown as RejectedCacheRecord<TValue>).data = {
      status: CacheStatus.REJECTED,
      error,
      promise,
    };
  },

  pend<TValue>(record: CacheRecord<TValue>) {
    record.data = {
      status: CacheStatus.PENDING,
      value: defer<TValue>(),
      controller: new AbortController(),
      lastValue: CacheRecord.isResolved(record)
        ? record.data.value
        : CacheRecord.isPending(record)
        ? record.data.lastValue
        : undefined,
    };
  },
};

export const CacheResultStatus = {
  ...CacheStatus,
  REVALIDATING: "revalidating",
} as const;
export type CacheResultStatus =
  (typeof CacheResultStatus)[keyof typeof CacheResultStatus];
export type CacheValueResult<TValue> =
  | [status: typeof CacheResultStatus.PENDING, value: undefined]
  | [status: typeof CacheResultStatus.REVALIDATING, value: TValue]
  | [status: typeof CacheResultStatus.REJECTED, error: unknown]
  | [status: typeof CacheResultStatus.RESOLVED, value: TValue];

type onEviction<Key> = (key: Key) => void;

export interface CacheMap<Key, Value> {
  clear(): void;
  delete(key: Key): boolean;
  get(key: Key): Value | undefined;
  has(key: Key): boolean;
  set(key: Key, value: Value): this;
  forEach(
    callbackfn: (value: Value, key: Key, map: CacheMap<Key, Value>) => void
  ): void;
}

export type SuspenseCacheOptions<TParams extends any[], TValue> = {
  getKey: (args: TParams) => string;
  getCache: (
    onEviction: onEviction<string>
  ) => CacheMap<string, CacheRecord<TValue>>;
  load: (context: CacheLoadContext, ...args: TParams) => Promise<TValue>;
  debug: boolean;
  name: string;
  devtools?: boolean;
  onError?: (key: TParams, error: unknown) => void;
  onSuccess?: (key: TParams, value: TValue) => void;
  ttl?: number | ((key: TParams, value: TValue) => number | undefined);
};

export type AnyFunction<ReturnType> = (...args: any[]) => ReturnType;

export type CacheLoadContext = {
  signal: AbortSignal;
  abort: () => void;
};

export type GetLoadParameters<T> = T extends (
  ...args: [any, ...infer args]
) => any
  ? args
  : never;

export type Resource = Record<
  string,
  (context: CacheLoadContext, ...args: any[]) => Promise<any> | any
>;

export type ResourceParams<T extends Resource> = {
  [Key in keyof T]: GetLoadParameters<T[Key]>;
};

export type ResourceValues<T extends Resource> = {
  [Key in keyof T]: Awaited<ReturnType<T[Key]>>;
};

export type Mutation<Trigger extends AnyFunction<any>> = [
  trigger: Trigger,
  isPending: boolean
];

export type SuspenseCacheEvent = {
  key: string;
  args: any[];
} & (
  | {
      type: "pending" | "abort" | "evict" | "invalidate" | "delete" | "clear";
    }
  | {
      type: "resolve";
      value: any;
    }
  | {
      type: "reject";
      error: any;
    }
  | {
      type: "set";
      value: any;
      lastValue: any;
    }
);

export const DevtoolsSymbol = Symbol.for("cache/devtools");
