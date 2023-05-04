import { defer } from './utils';

export const DeferredStatus = {
  PENDING: 'pending',
  RESOLVED: 'resolved',
  REJECTED: 'rejected',
} as const;

export type DeferredStatus = (typeof DeferredStatus)[keyof typeof DeferredStatus];

export interface Deferred<Value> {
  promise: Promise<Value>;
  status: DeferredStatus;
  reject(error: any): void;
  resolve(value?: Value): void;
}

export const CacheStatus = {
  ...DeferredStatus,
  REVALIDATING: 'revalidating',
  MISSING: 'missing',
} as const;

export type CacheStatus = (typeof CacheStatus)[keyof typeof CacheStatus];

export type SubscribeCallback = (status: CacheStatus) => void;
export type UnsubscribeFromCacheStatusFunction = () => void;

export interface RevalidatingCacheRecord<_TError, TValue> {
  data: {
    status: typeof CacheStatus.REVALIDATING;
    value: Deferred<TValue>;
    controller: AbortController;
    cached: TValue;
  };
}

export interface ResolvedCacheRecord<_TError, TValue> {
  data: {
    status: typeof CacheStatus.RESOLVED;
    value: TValue;
  };
}

export interface RejectedCacheRecord<TError, _TValue> {
  data: {
    status: typeof CacheStatus.REJECTED;
    error: TError;
  };
}

export interface PendingCacheRecord<_TError, TValue> {
  data: {
    status: typeof CacheStatus.PENDING;
    value: Deferred<TValue>;
    controller: AbortController;
  };
}

export type CacheRecord<TError, TValue> =
  | PendingCacheRecord<TError, TValue>
  | ResolvedCacheRecord<TError, TValue>
  | RejectedCacheRecord<TError, TValue>
  | RevalidatingCacheRecord<TError, TValue>;

type CacheRecordStatic = {
  makePending<TError, TValue>(): PendingCacheRecord<TError, TValue>;
  makeResolved<TError, TValue>(value: TValue): ResolvedCacheRecord<TError, TValue>;
  makeRejected<TError, TValue>(error: TError): RejectedCacheRecord<TError, TValue>;
  makeRevalidating<TError, TValue>(value: TValue): RevalidatingCacheRecord<TError, TValue>;
  isPending<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is PendingCacheRecord<TError, TValue>;
  isResolved<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is ResolvedCacheRecord<TError, TValue>;
  isRejected<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is RejectedCacheRecord<TError, TValue>;
  isRevalidating<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is RevalidatingCacheRecord<TError, TValue>;
  resolve<TError, TValue>(
    record: CacheRecord<TError, TValue>,
    value: TValue,
  ): asserts record is ResolvedCacheRecord<TError, TValue>;
  reject<TError, TValue>(
    record: CacheRecord<TError, TValue>,
    error: TError,
  ): asserts record is RejectedCacheRecord<TError, TValue>;
  revalidate<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): asserts record is RevalidatingCacheRecord<TError, TValue>;
  pend<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): asserts record is PendingCacheRecord<TError, TValue>;
};

// this is kept in the type file to take advantage of the type merging
export const CacheRecord: CacheRecordStatic = {
  makePending<TError, TValue>(): PendingCacheRecord<TError, TValue> {
    return {
      data: {
        status: CacheStatus.PENDING,
        value: defer<TValue>(),
        controller: new AbortController(),
      },
    };
  },

  makeResolved<TError, TValue>(value: TValue): ResolvedCacheRecord<TError, TValue> {
    return {
      data: {
        status: CacheStatus.RESOLVED,
        value,
      },
    };
  },

  makeRejected<TError, TValue>(error: TError): RejectedCacheRecord<TError, TValue> {
    return {
      data: {
        status: CacheStatus.REJECTED,
        error,
      },
    };
  },

  makeRevalidating<TError, TValue>(value: TValue): RevalidatingCacheRecord<TError, TValue> {
    return {
      data: {
        status: CacheStatus.REVALIDATING,
        value: defer<TValue>(),
        controller: new AbortController(),
        cached: value,
      },
    };
  },

  isPending<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is PendingCacheRecord<TError, TValue> {
    return record.data.status === CacheStatus.PENDING;
  },

  isResolved<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is ResolvedCacheRecord<TError, TValue> {
    return record.data.status === CacheStatus.RESOLVED;
  },

  isRejected<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is RejectedCacheRecord<TError, TValue> {
    return record.data.status === CacheStatus.REJECTED;
  },

  isRevalidating<TError, TValue>(
    record: CacheRecord<TError, TValue>,
  ): record is RevalidatingCacheRecord<TError, TValue> {
    return record.data.status === CacheStatus.REVALIDATING;
  },

  resolve<TError, TValue>(record: CacheRecord<TError, TValue>, value: TValue) {
    if (!CacheRecord.isPending(record) && !CacheRecord.isRevalidating(record)) {
      throw new Error('Cannot resolve a record that is not pending or revalidating');
    }
    const deferred = record.data.value;
    deferred.resolve(value);
    (record as unknown as ResolvedCacheRecord<TError, TValue>).data = {
      status: CacheStatus.RESOLVED,
      value,
    };
  },

  reject<TError, TValue>(record: CacheRecord<TError, TValue>, error: TError) {
    if (!CacheRecord.isPending(record) && !CacheRecord.isRevalidating(record)) {
      throw new Error('Cannot reject a record that is not pending or revalidating');
    }
    const deferred = record.data.value;
    deferred.reject(error);
    (record as unknown as RejectedCacheRecord<TError, TValue>).data = {
      status: CacheStatus.REJECTED,
      error,
    };
  },

  revalidate<TError, TValue>(
    record: ResolvedCacheRecord<TError, TValue> | RevalidatingCacheRecord<TError, TValue>,
  ) {
    if (!CacheRecord.isResolved(record) && !CacheRecord.isRevalidating(record)) {
      throw new Error('Cannot revalidate a record that is not resolved or revalidating');
    }
    record.data = {
      status: CacheStatus.REVALIDATING,
      value: defer<TValue>(),
      controller: new AbortController(),
      cached: record.data.status === 'resolved' ? record.data.value : record.data.cached,
    };
  },

  pend<TError, TValue>(record: CacheRecord<TError, TValue>) {
    if (!CacheRecord.isPending(record) && !CacheRecord.isRejected(record)) {
      throw new Error('Cannot pend a record that is not pending or rejected');
    }

    record.data = {
      status: CacheStatus.PENDING,
      value: defer<TValue>(),
      controller: new AbortController(),
    };
  },
};

export type CacheValueResult<TError, TValue> =
  | [status: typeof CacheStatus.PENDING | typeof CacheStatus.MISSING, value: undefined]
  | [status: typeof CacheStatus.REJECTED, error: TError]
  | [status: typeof CacheStatus.RESOLVED | typeof CacheStatus.REVALIDATING, value: TValue];

export const MutationStatus = {
  PENDING: CacheStatus.PENDING,
  RESOLVED: CacheStatus.RESOLVED,
  REJECTED: CacheStatus.REJECTED,
  IDLE: 'idle',
} as const;

export type MutationStatus = (typeof MutationStatus)[keyof typeof MutationStatus];

type onEviction<Key> = (key: Key) => void;

export interface CacheMap<Key, Value> {
  clear(): void;
  delete(key: Key): boolean;
  get(key: Key): Value | undefined;
  has(key: Key): boolean;
  set(key: Key, value: Value): this;
  forEach(callbackfn: (value: Value, key: Key, map: CacheMap<Key, Value>) => void): void;
}

export type SuspenseCacheOptions<TParams extends any[], TError, TValue> = {
  getKey: (...args: TParams) => string;
  getCache: (onEviction: onEviction<string>) => CacheMap<string, CacheRecord<TError, TValue>>;
  load: (context: CacheLoadContext, ...args: TParams) => PromiseLike<TValue> | TValue;
  debug: boolean;
  debugLabel?: string;
};

export type AnyFunction<ReturnType> = (...args: any[]) => ReturnType;

export type CacheLoadContext = {
  signal: AbortSignal;
};

export type ResourceParameters<T> = T extends (...args: [infer _cacheContext, ...infer args]) => any
  ? args
  : never;

export type Resource = Record<
  string,
  (context: CacheLoadContext, ...args: any[]) => PromiseLike<any> | any
>;
