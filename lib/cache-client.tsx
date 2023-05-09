import * as React from "react";

import { cache, SuspenseCache } from "./cache";
import {
  CacheLoadContext,
  CacheStatus,
  CacheValueResult,
  MutationStatus,
  SuspenseCacheOptions,
} from "./types";
import { useMutation as _useMutation } from "./hooks";

type Params = readonly [key: string, ...params: any[]];

export type CacheClientOptions = {
  primer?: Record<
    string,
    Partial<
      Omit<SuspenseCacheOptions, "load" | "getKey" | "onSuccess" | "onError">
    > & {
      load: (
        ctx: CacheLoadContext,
        ...args: any[]
      ) => PromiseLike<unknown> | unknown;
      initialData?: unknown;
    }
  >;
} & Partial<Omit<SuspenseCacheOptions, "load" | "getKey">>;

type CacheDefaults = Partial<Omit<SuspenseCacheOptions, "load" | "getKey">>;

export class CacheClient {
  readonly loadMap: WeakMap<(...params: any[]) => any, SuspenseCache> =
    new WeakMap();
  readonly cacheMap: Map<string, SuspenseCache>;
  readonly cacheDefaults?: CacheDefaults;

  constructor({ primer, ...cacheDefaults }: CacheClientOptions = {}) {
    const cacheMap = new Map();
    if (primer) {
      Object.entries(primer).forEach(([k, { load, ...options }]) => {
        const [key, ...args] = decodeKey(k);

        const suspenseCache = cache(load, {
          ...cacheDefaults,
          ...options,
        } satisfies Partial<SuspenseCacheOptions>);
        cacheMap.set(key, suspenseCache);
        if (options.initialData) {
          suspenseCache.set(options.initialData, ...args);
        }
      });
    }
    this.cacheMap = cacheMap;
    this.cacheDefaults = cacheDefaults;
  }

  invalidate(params: Params): void {
    const [key, ...args] = params;
    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.invalidate(...args);
    }
    throw new CacheMissing(key);
  }

  invalidateAll(): void {
    this.cacheMap.forEach((cache) => cache.invalidateAll());
  }

  peek<T>(params: Params): T | undefined {
    const [key, ...args] = params;
    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.peek(...args) as T | undefined;
    }
    throw new CacheMissing(key);
  }

  getStatus(params: Params): CacheStatus {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.getStatus(...args);
    }

    throw new CacheMissing(key);
  }

  subscribeToStatus(
    params: Params,
    callback: (status: CacheStatus) => void
  ): () => void {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.subscribeToStatus(callback, ...args);
    }
    throw new CacheMissing(key);
  }

  get<T>(params: Params): PromiseLike<T> | T {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.get(...args) as PromiseLike<T> | T;
    }
    throw new CacheMissing(key);
  }

  set(value: unknown, params: Params): void {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.set(value, ...args);
    }
    throw new CacheMissing(key);
  }

  has(params: Params): boolean {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.has(...args);
    }
    throw new CacheMissing(key);
  }

  clear(key: string): void {
    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.clear();
    }

    throw new CacheMissing(key);
  }

  delete(params: Params): boolean {
    const [key, ...args] = params;
    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.delete(...args);
    }

    throw new CacheMissing(key);
  }

  deleteIf(params: Params, predicate: (value: unknown) => boolean): boolean {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.deleteIf(predicate, ...args);
    }

    throw new CacheMissing(key);
  }

  preload(params: Params): void {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.preload(...args);
    }

    throw new CacheMissing(key);
  }

  abort(params: Params): boolean {
    const [key, ...args] = params;

    const maybeCache = this.cacheMap.get(key);
    if (maybeCache) {
      return maybeCache.abort(...args);
    }
    throw new CacheMissing(key);
  }

  read<T, TParams extends Params>(
    params: TParams,
    {
      load,
      ..._options
    }: Partial<
      Omit<SuspenseCacheOptions, "load" | "getKey" | "onSuccess" | "onError">
    > & {
      load?: (
        ctx: CacheLoadContext,
        ...args: ExtractArgs<TParams>
      ) => T | PromiseLike<T>;
    } = {}
  ): [T, boolean] {
    const client = this;
    const defaults = useCacheDefaults();
    const options = {
      ...defaults,
      ..._options,
    };
    const [key, ...args] = params;

    if (!load) {
      const maybeCache = client.cacheMap.get(key);
      if (maybeCache) {
        return maybeCache.read(...args) as [T, boolean];
      }

      throw new MissingLoaderError(key);
    }
    const loadCache = this.loadMap.get(load);
    if (loadCache) {
      return loadCache.read(...args) as [T, boolean];
    }

    const suspenseCache = cache(load, options);

    // @ts-expect-error
    client.cacheMap.set(key, suspenseCache);
    // @ts-expect-error
    client.loadMap.set(load, suspenseCache);

    return suspenseCache.read<any>(...args) as [T, boolean];
  }

  suspend<T, TParams extends Params>(
    params: TParams,
    {
      load,
      ..._options
    }: Partial<
      Omit<SuspenseCacheOptions, "load" | "getKey" | "onSuccess" | "onError">
    > & {
      load?: (
        ctx: CacheLoadContext,
        ...args: ExtractArgs<TParams>
      ) => T | PromiseLike<T>;
    } = {}
  ): T {
    const client = this;
    const defaults = useCacheDefaults();
    const options = {
      ...defaults,
      ..._options,
    };
    const [key, ...args] = params;

    if (!load) {
      const maybeCache = client.cacheMap.get(key);
      if (maybeCache) {
        return maybeCache.suspend(...args) as T;
      }

      throw new MissingLoaderError(key);
    }

    const loadCache = this.loadMap.get(load);
    if (loadCache) {
      return loadCache.suspend(...args) as T;
    }

    const suspenseCache = cache(load, options);

    // @ts-expect-error
    client.cacheMap.set(key, suspenseCache);
    // @ts-expect-error
    client.loadMap.set(load, suspenseCache);

    return suspenseCache.suspend<any>(...args) as T;
  }

  useStatus(params: Params): CacheStatus {
    const client = this;
    const [key, ...args] = params;

    const maybeCache = client.cacheMap.get(key);
    if (!maybeCache) {
      return CacheStatus.MISSING;
    }
    return maybeCache.useStatus(...args);
  }

  useValue<E, T, TParams extends Params>(
    params: TParams,
    {
      load,
      ..._options
    }: Partial<
      Omit<SuspenseCacheOptions, "load" | "getKey" | "onSuccess" | "onError">
    > & {
      load?: (
        ctx: CacheLoadContext,
        ...args: ExtractArgs<TParams>
      ) => T | PromiseLike<T>;
    } = {}
  ): CacheValueResult<E, T> {
    const client = this;
    const defaults = useCacheDefaults();
    const options = {
      ...defaults,
      ..._options,
    };
    const [key, ...args] = params;

    if (!load) {
      const maybeCache = client.cacheMap.get(key);
      if (maybeCache) {
        return maybeCache.useValue(...args) as CacheValueResult<E, T>;
      }

      throw new MissingLoaderError(key);
    }

    const loadCache = this.loadMap.get(load);

    if (loadCache) {
      return loadCache.useValue(...args) as CacheValueResult<E, T>;
    }

    const suspenseCache = cache(load, options);

    // @ts-expect-error
    client.cacheMap.set(key, suspenseCache);
    // @ts-expect-error
    client.loadMap.set(load, suspenseCache);

    return suspenseCache.useValue(...(params as any)) as CacheValueResult<E, T>;
  }

  useMutation<
    TValue,
    TParams extends any[],
    TMutationResult extends TValue | void
  >(
    keys: Params[],
    mutator: (...params: TParams) => Promise<TMutationResult>,
    options?: {
      updates: Params[];
      optimisticData?: TValue;
    }
  ): {
    status: MutationStatus;
    trigger: (...params: TParams) => Promise<TMutationResult>;
    reset: () => void;
  } {
    const makeClosuredCacheForKey = useMakeClosuredCacheForKey();
    return _useMutation(
      keys.map((key) => makeClosuredCacheForKey(key)),
      mutator,
      options
        ? {
            ...options,
            updates: options?.updates?.map((key) =>
              makeClosuredCacheForKey(key)
            ),
          }
        : undefined
    );
  }
}

export class MissingLoaderError extends Error {
  constructor(key: string) {
    super(`Cache missing loader for key: ${key}`);
  }
}

export class CacheMissing extends Error {
  constructor(key: string) {
    super(`Cache missing for key: ${key}`);
  }
}

const CacheContext = React.createContext<CacheClient>(new CacheClient());
const CacheOptionsContext = React.createContext<CacheDefaults | undefined>(
  undefined
);

export function CacheProvider({
  children,
  client,
}: {
  children: React.ReactNode;
  client: CacheClient;
}) {
  return (
    <CacheContext.Provider value={client}>{children}</CacheContext.Provider>
  );
}

let weakSet: WeakSet<CacheClientOptions> = new WeakSet();

export function CacheOptionsProvider({
  children,
  options: { primer, ...cacheDefaults },
}: {
  children: React.ReactNode;
  options: CacheClientOptions;
}) {
  const client = useCacheClient();
  React.useState(() => {
    if (primer && !weakSet.has(primer)) {
      Object.entries(primer).forEach(([k, { load, ...options }]) => {
        const [key, ...args] = decodeKey(k);

        const suspenseCache = cache(load, {
          ...client.cacheDefaults,
          ...cacheDefaults,
          ...options,
        });
        client.cacheMap.set(key, suspenseCache);
        if (options.initialData) {
          suspenseCache.set(options.initialData, ...args);
        }
      });

      weakSet.add(primer);
    }
  });

  return (
    <CacheOptionsContext.Provider value={cacheDefaults}>
      {children}
    </CacheOptionsContext.Provider>
  );
}

export function useCacheClient(): CacheClient {
  return React.useContext(CacheContext);
}

function useCacheDefaults(): CacheDefaults {
  const client = useCacheClient();
  return { ...client.cacheDefaults, ...React.useContext(CacheOptionsContext) };
}

export function useMakeClosuredCacheForKey(): (key: Params) => {
  id: string;
  getStatus: () => CacheStatus;
  subscribeToStatus: (callback: () => void) => () => void;
  suspend: () => any;
  invalidate: () => void;
  peek: () => any;
  set: (value: any) => void;
} {
  const client = useCacheClient();
  return (key: Params) => ({
    id: makeCacheKey(key),
    getStatus: () => client.getStatus(key),
    subscribeToStatus: (callback: () => void) =>
      client.subscribeToStatus(key, callback),
    suspend: () => client.suspend(key),
    invalidate: () => client.invalidate(key),
    peek: () => client.peek(key),
    set: (value: any) => client.set(value, key),
  });
}

const delimiter = ":@:";

export function makeCacheKey(params: Params): string {
  const args = params;
  return args.map((x) => JSON.stringify(x)).join(delimiter);
}

function decodeKey(key: string): Params {
  if (!key.includes(delimiter)) {
    return [key];
  }
  return key.split(delimiter).map((x) => {
    return JSON.parse(x);
  }) as any;
}

type ExtractArgs<T> = T extends readonly [infer _Key, ...infer Args]
  ? Args
  : never;
