import type { AnyFunction, Deferred } from "./types";
import { CacheStatus, DeferredStatus } from "./types";

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

// a Deferred is a type of Promise that can be resolved or rejected from the outside
// e.g: const deferred = defer<string>(); deferred.resolve('hello'); deferred.promise.then(console.log);
export function defer<Type>(): Deferred<Type> {
  let status: DeferredStatus = DeferredStatus.PENDING;

  let rejectPromise: (error: Error) => void;
  let resolvePromise: (value: Type | PromiseLike<Type>) => void;

  const promise = new Promise<Type>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });

  // prevent unhandled rejections
  promise.catch(() => {});

  function assertPending() {
    if (status !== DeferredStatus.PENDING) {
      throw Error(`Deferred has already been ${status}`);
    }
  }

  const deferred: Deferred<Type> = {
    promise,
    status,
    reject(error: Error) {
      assertPending();

      status = DeferredStatus.REJECTED;

      rejectPromise(error);
    },

    resolve(value: Type) {
      assertPending();

      status = DeferredStatus.RESOLVED;

      resolvePromise(value);
    },
  };

  return deferred;
}

type Suspender<T> = (...args: any[]) => T;

// Helper function to read from multiple Suspense caches in parallel.
// This method will re-throw any thrown value, but only after also calling subsequent caches.
export function all<Func extends Suspender<any>[]>(
  suspenders: [...Func]
): { [K in keyof Func]: ReturnType<Extract<Func[K], AnyFunction<any>>> } {
  const values: any[] = [];
  let thrownValue = null;

  suspenders.forEach((suspend) => {
    try {
      values.push(suspend());
    } catch (error) {
      thrownValue = error;
    }
  });

  if (thrownValue !== null) {
    throw thrownValue;
  }

  return values as any;
}

export function allProps<Props extends Record<string, Suspender<any>>>(
  props: Props
) {
  const keys = Object.keys(props);
  const values = all(keys.map((key) => props[key]));

  return keys.reduce((acc, key, index) => {
    acc[key as keyof Props] = values[index];
    return acc;
  }, {} as { [K in keyof Props]: ReturnType<Props[K]> });
}

export function cacheValueIsRejected(status: CacheStatus): boolean {
  return status === CacheStatus.REJECTED;
}

export function cacheValueIsResolved(status: CacheStatus): boolean {
  return status === CacheStatus.RESOLVED;
}

export function cacheValueIsRevalidating(status: CacheStatus): boolean {
  return status === CacheStatus.REVALIDATING;
}

export function cacheValueIsPending(status: CacheStatus): boolean {
  return status === CacheStatus.PENDING;
}

export function cacheValueIsMissing(status: CacheStatus): boolean {
  return status === CacheStatus.MISSING;
}

export const cacheKeyDelimiter = ":@:";
