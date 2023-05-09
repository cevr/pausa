/* eslint-disable no-empty */
import * as React from "react";

import { CacheStatus, MutationStatus } from "./types";
import { all } from "./utils";

// we call these "closured" because they are meant to capture the cache instance with its arguments
// already applied. makes typing easier and avoids having to pass the arguments to the hooks

type ClosuredCache = {
  getStatus: () => CacheStatus;
  subscribeToStatus: (callback: () => void) => () => void;
  suspend: () => any;
};

type ClosuredInvalidationCache = {
  id: string;
  invalidate: () => void;
};

type ClosuredUpdateCache = {
  id: string;
  peek: () => any;
  set: (value: any) => void;
  invalidate: () => void;
  getStatus: () => CacheStatus;
};

export function useMutation<
  TValue,
  TParams extends any[],
  TMutationResult extends TValue | void
>(
  cachesToInvalidate: ClosuredInvalidationCache[],
  mutator: (...args: TParams) => Promise<TMutationResult>,
  options?: {
    updates: ClosuredUpdateCache[];
    optimisticData?: TValue;
  }
): {
  status: MutationStatus;
  trigger: (...args: TParams) => Promise<TMutationResult>;
  reset: () => void;
} {
  const [status, setStatus] = React.useState<MutationStatus>(
    MutationStatus.IDLE
  );
  return {
    reset: React.useCallback(() => setStatus(MutationStatus.IDLE), []),
    status,
    trigger: async (...args) => {
      setStatus(MutationStatus.PENDING);
      let rollbackData: [CacheStatus, TValue | undefined][] = [];
      if (options?.optimisticData) {
        options.updates.forEach((cache) => {
          const cacheStatus = cache.getStatus();
          let oldValue: TValue | undefined = undefined;
          try {
            oldValue = cache.peek();
          } catch {
            // if it fails, it's because the cache is rejected
            // we invalidate if it's not resolved anyway
          }
          rollbackData.push([cacheStatus, oldValue]);
          cache.set(options.optimisticData!);
        });
      }
      return mutator(...args)
        .then((res) => {
          cachesToInvalidate
            .filter(({ id: invalidationId }) => {
              if (options?.updates) {
                return options.updates.every(
                  ({ id: updateId }) => invalidationId !== updateId
                );
              }
              return true;
            })
            .forEach((cache) => {
              cache.invalidate();
            });
          if (options?.updates) {
            options.updates.forEach((cache) => {
              cache.set(res);
            });
          }
          setStatus(MutationStatus.RESOLVED);
          return res;
        })
        .catch((err) => {
          if (options) {
            rollbackData.forEach(([originalStatus, oldValue], i) => {
              const cache = options.updates[i];
              if (originalStatus !== CacheStatus.RESOLVED) {
                cache.invalidate();
              } else {
                cache.set(oldValue!);
              }
            });
          }
          setStatus(MutationStatus.REJECTED);
          throw err;
        });
    },
  };
}

// this provides a way to get the up to date suspense reads without using Cache.read
// if you don't care about whether its revalidating, you can use this
export function useSuspend<Cache extends Omit<ClosuredCache, "getStatus">>(
  cache: Cache
): ReturnType<Cache["suspend"]> {
  const forceUpdate = useForceUpdate();
  React.useEffect(() => {
    const unsub = cache.subscribeToStatus(forceUpdate);
    return () => unsub();
  }, [cache, forceUpdate]);
  return cache.suspend();
}

// this provides a way to get the up to date suspense reads concurrently
export function useSuspendAll<Caches extends readonly ClosuredCache[]>(
  caches: Caches
): {
  [K in keyof Caches]: ReturnType<Caches[K]["suspend"]>;
} {
  const forceUpdate = useForceUpdate();

  React.useEffect(() => {
    const unsubs = caches.map(({ subscribeToStatus }) =>
      subscribeToStatus(forceUpdate)
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [caches, forceUpdate]);

  return all(caches.map((cache) => cache.suspend)) as any;
}

export function useSuspendAllProps<
  Caches extends Record<string, ClosuredCache>
>(
  caches: Caches
): {
  [K in keyof Caches]: ReturnType<Caches[K]["suspend"]>;
} {
  const forceUpdate = useForceUpdate();
  React.useEffect(() => {
    const unsubs = Object.values(caches).map(({ subscribeToStatus }) =>
      subscribeToStatus(forceUpdate)
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [caches, forceUpdate]);

  // eslint-disable-next-line compat/compat -- this is polyfilled in gcn
  return Object.fromEntries(
    all(
      Object.entries(caches).map(([key, cache]) => () => [key, cache.suspend()])
    )
  );
}

export function useReadAll<Caches extends readonly ClosuredCache[]>(
  caches: Caches
): {
  [K in keyof Caches]: [ReturnType<Caches[K]["suspend"]>, boolean];
} {
  const forceUpdate = useForceUpdate();

  React.useEffect(() => {
    const unsubs = caches.map(({ subscribeToStatus }) =>
      subscribeToStatus(forceUpdate)
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [caches, forceUpdate]);

  return all(
    caches.map(
      (cache) => () =>
        [
          cache.suspend(),
          cache.getStatus() === CacheStatus.REVALIDATING,
        ] as const
    )
  ) as any;
}

export function useReadAllProps<Caches extends Record<string, ClosuredCache>>(
  caches: Caches
): {
  [K in keyof Caches]: [ReturnType<Caches[K]["suspend"]>, boolean];
} {
  const forceUpdate = useForceUpdate();
  React.useEffect(() => {
    const unsubs = Object.values(caches).map(({ subscribeToStatus }) =>
      subscribeToStatus(forceUpdate)
    );
    return () => unsubs.forEach((unsub) => unsub());
  }, [caches, forceUpdate]);

  // eslint-disable-next-line compat/compat -- this is polyfilled in gcn
  return Object.fromEntries(
    all(
      Object.entries(caches).map(([key, cache]) => () => [
        key,
        [cache.suspend(), cache.getStatus() === CacheStatus.REVALIDATING],
      ])
    )
  );
}

export function useForceUpdate() {
  const [_, forceUpdate] = React.useReducer((s) => s + 1, 0);
  return forceUpdate;
}
