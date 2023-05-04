/* eslint-disable no-empty */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-shadow */

import { LRUCache } from 'lru-cache';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { SuspenseCache } from './cache';
import { cache, cacheResource } from './cache';
import { ErrorBoundary } from './test-utils';
import type { CacheLoadContext, Deferred } from './types';
import { CacheStatus } from './types';
import { defer, isPromiseLike } from './utils';

function defaultLoad(options: CacheLoadContext, key: string): Promise<string> | string {
  if (key.startsWith('async')) {
    return Promise.resolve(key);
  }
  if (key.startsWith('error')) {
    return Promise.reject(key);
  }
  return key;
}

describe('SuspenseCache', () => {
  let suspenseCache: SuspenseCache<[string], any, string>;
  let load: Mock<[CacheLoadContext, string], Promise<string> | string>;
  let getCacheKey: Mock<[string], string>;

  beforeEach(() => {
    load = vi.fn();
    load.mockImplementation(defaultLoad);

    getCacheKey = vi.fn();
    getCacheKey.mockImplementation((key) => key.toString());

    suspenseCache = cache(load, {
      getKey: getCacheKey,
    });
  });

  async function fakeSuspend(read: () => any) {
    try {
      return read();
    } catch (thenable) {
      expect(isPromiseLike(thenable)).toBe(true);

      await thenable;

      return read();
    }
  }

  it('should supply a working default getCacheKey if none is provided', () => {
    const suspenseCache = cache(
      (_context, string: string, _number: number, _boolean: boolean) => string,
    );

    suspenseCache.set('foo', 'string', 123, true);
    suspenseCache.set('bar', 'other string', 456, false);

    expect(suspenseCache.peek('string', 123, true)).toEqual('foo');
    expect(suspenseCache.peek('other string', 456, false)).toEqual('bar');

    const resourceCache = cacheResource({
      '/1': (_context, string: string, _number: number, _boolean: boolean) => string,
      '/2': (_context, string: string, _number: number, _boolean: boolean) => string,
    });

    resourceCache.set('foo', '/1', 'string', 123, true);
    resourceCache.set('bar', '/2', 'other string', 456, false);

    expect(resourceCache.peek('/1', 'string', 123, true)).toEqual('foo');
    expect(resourceCache.peek('/2', 'other string', 456, false)).toEqual('bar');
  });

  describe('abort', () => {
    it('should abort an active request', () => {
      let abortSignal: AbortSignal;
      let deferred: Deferred<string>;
      load.mockImplementation(async (options, _params) => {
        abortSignal = options.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      expect(suspenseCache.abort('async')).toBe(true);
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.MISSING);

      expect(abortSignal!.aborted).toBe(true);

      deferred!.resolve('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.MISSING);
    });

    it('should restart an aborted request on next fetch', async () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      const initialDeferred = deferred!;

      expect(suspenseCache.abort('async')).toBe(true);
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.MISSING);

      const fetchTwo = suspenseCache.get('async');

      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);
      expect(load).toHaveBeenCalled();

      // At this point, even if the first request completes– it should be ignored.
      initialDeferred.resolve('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      // But the second request should be processed.
      deferred!.resolve('async');
      await fetchTwo;
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.RESOLVED);
    });

    it('should gracefully handle an abort request for a completed fetch', () => {
      suspenseCache.get('sync');
      expect(suspenseCache.getStatus('sync')).toBe(CacheStatus.RESOLVED);

      expect(suspenseCache.abort('sync')).toBe(false);
    });

    it('should set the cache item to MISSING if the abort happens while it is pending', () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });
      suspenseCache.get('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      suspenseCache.abort('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.MISSING);
    });

    it('should transition the cache item to resolved if the abort happens while it is revalidating', async () => {
      let deferred: Deferred<string> | null = null;
      load.mockImplementation(async () => {
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.set('async', 'async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.RESOLVED);

      suspenseCache.invalidate('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.REVALIDATING);

      suspenseCache.abort('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.RESOLVED);
    });
  });

  describe('cache.set', () => {
    it('should set and return pre-fetched values without calling load again', () => {
      suspenseCache.set('SYNC', 'sync-1');
      suspenseCache.set('ASYNC', 'async-1');

      expect(suspenseCache.peek('sync-1')).toEqual('SYNC');
      expect(suspenseCache.peek('async-1')).toEqual('ASYNC');

      expect(load).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('should event cached items', () => {
      suspenseCache.set('VALUE 1', 'sync-1');
      suspenseCache.set('VALUE 2', 'sync-2');

      expect(suspenseCache.peek('sync-1')).toEqual('VALUE 1');
      expect(suspenseCache.peek('sync-2')).toEqual('VALUE 2');

      expect(load).not.toHaveBeenCalled();

      suspenseCache.delete('sync-1');

      expect(suspenseCache.peek('sync-1')).toEqual(undefined);
      expect(suspenseCache.peek('sync-2')).toEqual('VALUE 2');
    });

    it('should refetch requested items after deletion', () => {
      suspenseCache.set('VALUE', 'sync');
      suspenseCache.delete('sync');

      expect(load).not.toHaveBeenCalled();

      suspenseCache.get('sync');

      expect(load).toHaveBeenCalled();
    });
  });

  describe('clear', () => {
    it('should clear cached items', () => {
      suspenseCache.set('VALUE 1', 'sync-1');
      suspenseCache.set('VALUE 2', 'sync-2');

      expect(suspenseCache.peek('sync-1')).toEqual('VALUE 1');
      expect(suspenseCache.peek('sync-2')).toEqual('VALUE 2');

      expect(load).not.toHaveBeenCalled();

      suspenseCache.clear();

      expect(suspenseCache.peek('sync-1')).toEqual(undefined);
      expect(suspenseCache.peek('sync-2')).toEqual(undefined);
    });

    it('should refetch requested items after deletion', () => {
      suspenseCache.set('VALUE 1', 'sync-1');
      suspenseCache.set('VALUE 2', 'sync-2');

      expect(load).not.toHaveBeenCalled();

      suspenseCache.clear();

      suspenseCache.get('sync-1');
      suspenseCache.get('sync-2');

      expect(load).toHaveBeenCalledTimes(2);
    });
  });

  describe('getStatus', () => {
    it('should return not-found for keys that have not been loaded', () => {
      expect(suspenseCache.getStatus('nope')).toBe(CacheStatus.MISSING);
    });

    it('should transition from pending to resolved', async () => {
      const willResolve = suspenseCache.get('async');

      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      await willResolve;

      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.RESOLVED);
    });

    it('should transition from pending to rejected', async () => {
      let deferred: Deferred<string>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });

      const promise = suspenseCache.get('error');

      expect(suspenseCache.getStatus('error')).toBe(CacheStatus.PENDING);

      deferred!.reject({ key: 'error--' });
      try {
        await promise;
      } catch {}

      expect(suspenseCache.getStatus('error')).toBe(CacheStatus.REJECTED);
    });

    it('should return resolved or rejected for keys that have already been loaded', async () => {
      const willResolve = suspenseCache.get('sync');
      await willResolve;
      expect(suspenseCache.getStatus('sync')).toBe(CacheStatus.RESOLVED);

      const willReject = suspenseCache.get('error');
      try {
        await willReject;
      } catch (error) {}
      expect(suspenseCache.getStatus('error')).toBe(CacheStatus.REJECTED);
    });
  });

  describe('get', () => {
    it('should return async values', async () => {
      const thenable = suspenseCache.get('async');

      expect(isPromiseLike(thenable)).toBe(true);

      await expect(await thenable).toBe('async');
    });

    it('should return sync values', () => {
      expect(suspenseCache.get('sync')).toBe('sync');
    });

    it('should only load the same value once (per key)', () => {
      expect(suspenseCache.get('sync')).toBe('sync');
      expect(suspenseCache.get('sync')).toBe('sync');

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('suspend', () => {
    it('should suspend on async values', async () => {
      await expect(await fakeSuspend(() => suspenseCache.suspend('async'))).toBe('async');
    });

    it('should not suspend on sync values', () => {
      expect(suspenseCache.suspend('sync')).toBe('sync');
    });

    it('should only fetch the same value once (per key)', () => {
      expect(suspenseCache.suspend('sync')).toBe('sync');
      expect(suspenseCache.suspend('sync')).toBe('sync');

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('invalidate', () => {
    it('should change the status of a cached value to revalidating if resolved', () => {
      suspenseCache.set('async', 'async');
      suspenseCache.invalidate('async');

      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.REVALIDATING);
    });

    it('should abort the current request if the value is pending or revalidating', () => {
      let signal: AbortSignal;
      let deferred: Deferred<string>;
      load.mockImplementation((ctx, _key) => {
        signal = ctx.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);
      const originalSignal = signal!;
      suspenseCache.invalidate('async');
      expect(originalSignal.aborted).toBe(true);
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      suspenseCache.set('async-2', 'async-2');
      suspenseCache.invalidate('async-2');
      expect(suspenseCache.getStatus('async-2')).toBe(CacheStatus.REVALIDATING);
      const originalSignal2 = signal!;
      suspenseCache.invalidate('async-2');
      expect(originalSignal2.aborted).toBe(true);
      expect(suspenseCache.getStatus('async-2')).toBe(CacheStatus.REVALIDATING);
    });

    it('should not cause a suspended request to throw when revalidating', async () => {
      let deferred: Deferred<string>;
      load.mockImplementation((_ctx, _key) => {
        deferred = defer();
        return deferred.promise;
      });
      suspenseCache.set('async', 'async');
      suspenseCache.invalidate('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.REVALIDATING);
      expect(() => suspenseCache.suspend('async')).not.toThrow();
    });

    it('should cause a missing value to be preloaded', () => {
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.MISSING);
      suspenseCache.invalidate('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);
    });
  });

  describe('invalidateAll', () => {
    it('should invalidate all values', () => {
      let deferred: Deferred<string>;
      load.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });
      suspenseCache.set('async', 'async');
      suspenseCache.set('sync', 'sync');
      suspenseCache.invalidateAll();
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.REVALIDATING);
      expect(suspenseCache.getStatus('sync')).toBe(CacheStatus.REVALIDATING);
      expect(suspenseCache.getStatus('missing')).toBe(CacheStatus.MISSING);
    });

    it('should abort all pending requests', () => {
      let signals: AbortSignal[] = [];
      let deferred: Deferred<string>;
      load.mockImplementation((ctx, _key) => {
        signals.push(ctx.signal);
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get('async');
      suspenseCache.get('async-2');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus('async-2')).toBe(CacheStatus.PENDING);
      suspenseCache.invalidateAll();
      expect(signals.slice(0, 1).every((signal) => signal.aborted)).toBe(true);
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);
      expect(suspenseCache.getStatus('async-2')).toBe(CacheStatus.PENDING);
    });
  });

  describe('peek', () => {
    it('should return undefined for values not yet loaded', () => {
      expect(suspenseCache.peek('sync')).toBeUndefined();
      expect(load).not.toHaveBeenCalled();
    });

    it('should return undefined for values that are pending', () => {
      suspenseCache.get('async');
      expect(suspenseCache.peek('async')).toBeUndefined();
    });

    it('should return a cached value for values that have resolved', () => {
      suspenseCache.get('sync');
      expect(suspenseCache.peek('sync')).toEqual('sync');
    });

    it('should return a cached value for values that are revalidating', () => {
      suspenseCache.set('async', 'async');
      suspenseCache.invalidate('async');
      expect(suspenseCache.peek('async')).toEqual('async');
    });

    it('should return a cached value for values that are overwritten', () => {
      suspenseCache.set('sync', 'sync');
      suspenseCache.set('new-sync', 'sync');
      expect(suspenseCache.peek('sync')).toEqual('new-sync');
    });

    it('should throw for values that have rejected', async () => {
      try {
        await suspenseCache.get('error-expected');
      } catch (error) {}
      expect(() => suspenseCache.peek('error-expected')).toThrow();
    });
  });

  describe('preload', () => {
    it('should start fetching a resource', async () => {
      suspenseCache.preload('sync-1');

      load.mockReset();

      // Verify value already loaded
      suspenseCache.get('sync-1');
      expect(load).not.toHaveBeenCalled();
      expect(suspenseCache.suspend('sync-1')).toEqual('sync-1');

      // Verify other values fetch independently
      load.mockImplementation(defaultLoad);
      suspenseCache.get('sync-2');
      expect(load).toHaveBeenCalledTimes(1);
      expect(load.mock.lastCall?.[1]).toEqual('sync-2');
      expect(suspenseCache.suspend('sync-2')).toEqual('sync-2');
    });
  });

  describe('subscribeToStatus', () => {
    let callbackA: Mock;
    let callbackB: Mock;

    beforeEach(() => {
      callbackA = vi.fn();
      callbackB = vi.fn();
    });

    it('should subscribe to keys that have not been loaded', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync');

      expect(callbackA).toHaveBeenCalledTimes(0);

      await Promise.resolve();

      expect(callbackA).toHaveBeenCalledTimes(0);
    });

    it('should notify of the transition from undefined to resolved for synchronous caches', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync');

      expect(callbackA).toHaveBeenCalledTimes(0);

      suspenseCache.get('sync');

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it('should notify of the transition from undefined to pending to resolved for async caches', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'async');

      expect(callbackA).toHaveBeenCalledTimes(0);

      const thenable = suspenseCache.get('async');

      expect(callbackA).toHaveBeenCalledTimes(1);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);

      await thenable;

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it('should only notify each subscriber once', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync');
      suspenseCache.subscribeToStatus(callbackB, 'sync');

      expect(callbackA).toHaveBeenCalledTimes(0);

      expect(callbackB).toHaveBeenCalledTimes(0);

      suspenseCache.get('sync');

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it('should not notify after a subscriber unsubscribes', async () => {
      const unsubscribe = suspenseCache.subscribeToStatus(callbackA, 'sync');

      suspenseCache.get('sync');

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      unsubscribe();

      suspenseCache.get('sync');

      expect(callbackA).toHaveBeenCalledTimes(2);
    });

    it('should track subscribers separately, per key', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync-1');
      suspenseCache.subscribeToStatus(callbackB, 'sync-2');

      callbackA.mockReset();
      callbackB.mockReset();

      suspenseCache.get('sync-2');

      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalledTimes(2);
    });

    it('should track un-subscriptions separately, per key', async () => {
      const unsubscribeA = suspenseCache.subscribeToStatus(callbackA, 'sync-1');
      suspenseCache.subscribeToStatus(callbackB, 'sync-2');

      callbackA.mockReset();
      callbackB.mockReset();

      unsubscribeA();

      suspenseCache.get('sync-1');
      suspenseCache.get('sync-2');

      expect(callbackA).not.toHaveBeenCalled();
      expect(callbackB).toHaveBeenCalledTimes(2);
    });

    it('should notify subscribers after a value is deleted', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync-1');
      suspenseCache.subscribeToStatus(callbackB, 'sync-2');

      suspenseCache.get('sync-1');
      suspenseCache.get('sync-2');

      await Promise.resolve();

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      suspenseCache.delete('sync-1');

      expect(callbackA).toHaveBeenCalledTimes(3);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.MISSING);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);
    });

    it('should notify subscribers after all values are deleted', async () => {
      suspenseCache.subscribeToStatus(callbackA, 'sync-1');
      suspenseCache.subscribeToStatus(callbackB, 'sync-2');
      suspenseCache.get('sync-1');
      suspenseCache.get('sync-2');
      await Promise.resolve();

      expect(callbackA).toHaveBeenCalledTimes(2);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.RESOLVED);
      expect(callbackB).toHaveBeenCalledTimes(2);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.PENDING);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.RESOLVED);

      suspenseCache.clear();

      expect(callbackA).toHaveBeenCalledTimes(3);
      expect(callbackA).toHaveBeenCalledWith(CacheStatus.MISSING);
      expect(callbackB).toHaveBeenCalledTimes(3);
      expect(callbackB).toHaveBeenCalledWith(CacheStatus.MISSING);
    });
  });

  describe('getCache: LRU Cache', () => {
    type Response = string;
    let onEvictFn: Mock<[string], void>;
    let load: Mock<[CacheLoadContext, string], Promise<Response> | Response>;
    let lruCache: SuspenseCache<[string], unknown, Response>;

    beforeEach(() => {
      onEvictFn = vi.fn();

      load = vi.fn();
      load.mockImplementation((_, key) => {
        if (key.startsWith('async')) {
          return Promise.resolve(key);
        }
        if (key.startsWith('error')) {
          return Promise.reject(key);
        }
        return key;
      });

      lruCache = cache(load, {
        getCache: (onEvict) =>
          new LRUCache({
            max: 1,
            disposeAfter: (value, key, reason) => {
              if (reason === 'evict') {
                onEvictFn(key);
                onEvict(key);
              }
            },
          }),
      });
    });

    it('getStatus: should return not-found status if value has been deleted by provided cache', async () => {
      lruCache.set('test', 'test');
      expect(lruCache.peek('test')).toEqual('test');

      lruCache.set('test2', 'test2');

      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.getStatus('test')).toBe(CacheStatus.MISSING);
    });

    it('suspend: should throw if previously loaded value has been deleted by provided cache', async () => {
      let deferred: Deferred<Response>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });
      lruCache.set('test', 'test');
      expect(lruCache.peek('test')).toEqual('test');

      lruCache.set('test2', 'test2');
      expect(onEvictFn).toHaveBeenCalledTimes(1);
      expect(lruCache.getStatus('test')).toBe(CacheStatus.MISSING);

      expect(() => lruCache.suspend('test')).toThrow();
    });

    it('peek: should return undefined if previously loaded value has been deleted by provided cache', async () => {
      lruCache.set('test', 'test');
      expect(lruCache.peek('test')).toEqual('test');

      lruCache.set('test2', 'test2');
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek('test')).toBeUndefined();
      expect(lruCache.getStatus('test')).toBe(CacheStatus.MISSING);
    });

    it('read: should re-suspend if previously loaded value has been deleted by provided cache', async () => {
      let deferred: Deferred<Response>;
      load.mockImplementation(() => {
        deferred = defer();
        return deferred.promise;
      });
      lruCache.set('test', 'test');
      expect(lruCache.peek('test')).toEqual('test');

      lruCache.set('test2', 'test2');
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek('test')).toBeUndefined();
      expect(lruCache.getStatus('test')).toBe(CacheStatus.MISSING);

      expect(() => lruCache.suspend('test')).toThrow();
    });

    it('get: should re-suspend if previously loaded value has been collected by provided cache', async () => {
      lruCache.set('test', 'test');
      expect(lruCache.peek('test')).toEqual('test');

      lruCache.set('test2', 'test2');
      expect(onEvictFn).toHaveBeenCalledTimes(1);

      expect(lruCache.peek('test')).toBeUndefined();
      expect(lruCache.getStatus('test')).toBe(CacheStatus.MISSING);

      expect(await lruCache.get('test')).toEqual('test');
    });
  });

  describe('useStatus', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let getCacheKey: Mock<[string], string>;
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
        if (key.startsWith('async')) {
          return Promise.resolve(key);
        }
        if (key.startsWith('error')) {
          return Promise.reject(key);
        }
        return key;
      });

      getCacheKey = vi.fn();
      getCacheKey.mockImplementation(([key]) => key.toString());

      suspenseCache = cache(fetch, {
        getKey: getCacheKey,
      });

      lastRenderedStatus = undefined;
      renderCount = 0;
    });

    it('should return not-found for keys that have not been loaded', () => {
      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="test" />);
      });

      expect(lastRenderedStatus).toBe(CacheStatus.MISSING);
    });

    it('should transition from pending to resolved', async () => {
      const promise = suspenseCache.get('async');

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="async" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => await promise);

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
    });

    it('should transition from pending to rejected', async () => {
      const promise = suspenseCache.get('error');

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="error" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => {
        try {
          await promise;
        } catch (error) {}
      });

      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it('should return resolved for keys that have already been loaded', async () => {
      const promise = suspenseCache.get('sync');
      await promise;

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="sync" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
    });

    it('should be alerted to a value that has been overwritten', async () => {
      const promise = suspenseCache.get('sync');
      await promise;

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="sync" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);

      await act(async () => {
        suspenseCache.set('new-value', 'sync');
      });

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(renderCount).toBe(2);
    });

    it('should return rejected for keys that have already failed', async () => {
      try {
        await suspenseCache.get('error');
      } catch (error) {}

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="error" />);
      });
      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it('should update in response to an aborted request', async () => {
      let abortSignal: AbortSignal | undefined;
      let deferred: Deferred<string> | undefined;
      fetch.mockImplementation(async (ctx, _params) => {
        abortSignal = ctx.signal;
        deferred = defer();
        return deferred.promise;
      });

      suspenseCache.get('async');
      expect(suspenseCache.getStatus('async')).toBe(CacheStatus.PENDING);

      const container = document.createElement('div');
      const root = createRoot(container);
      act(() => {
        root.render(<Component string="async" />);
      });

      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      act(() => {
        expect(suspenseCache.abort('async')).toBe(true);
      });
      expect(abortSignal?.aborted).toBe(true);

      await Promise.resolve();

      expect(lastRenderedStatus).toBe(CacheStatus.MISSING);
    });
  });

  describe('useValue', () => {
    type Value = { key: string };
    type ErrorType = { error: string };
    let suspenseCache: SuspenseCache<[string], ErrorType, Value>;
    let fetch: Mock<[CacheLoadContext, string], Promise<Value> | Value>;

    let container: HTMLDivElement | null = null;
    let lastRenderedStatus: CacheStatus | undefined = undefined;
    let lastRenderedValue: Value | ErrorType | undefined = undefined;

    let pendingDeferred: Deferred<Value>[] = [];

    function Component({ cacheKey }: { cacheKey: string }): any {
      const [status, value] = suspenseCache.useValue(cacheKey);

      lastRenderedStatus = status;
      lastRenderedValue = value;

      return null;
    }

    async function mount() {
      container = document.createElement('div');
      const root = createRoot(container);
      await act(async () => {
        root.render(
          <>
            <ErrorBoundary>
              <Component cacheKey="test" />
            </ErrorBoundary>
          </>,
        );
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, _key) => {
        const deferred = defer<Value>();

        pendingDeferred.push(deferred);

        return deferred.promise;
      });

      container = null;

      suspenseCache = cache(fetch, {
        getCache: (onEvict) =>
          new LRUCache({
            max: 1,
            disposeAfter: (value, key, reason) => {
              if (reason === 'evict') {
                onEvict(key);
              }
            },
          }),
      });

      lastRenderedStatus = undefined;
      lastRenderedValue = undefined;

      pendingDeferred = [];
    });

    it('should return values that have already been loaded', async () => {
      suspenseCache.set({ key: 'cached' }, 'test');

      await mount();

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(lastRenderedValue).toEqual({ key: 'cached' });
    });

    it('should be alerted to a value that has been overwritten', async () => {
      suspenseCache.set({ key: 'cached' }, 'test');

      await mount();

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(lastRenderedValue).toEqual({ key: 'cached' });

      await act(async () => {
        suspenseCache.set({ key: 'new-value' }, 'test');
      });

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(lastRenderedValue).toEqual({ key: 'new-value' });
    });

    it('should fetch values that have not yet been fetched', async () => {
      expect(suspenseCache.getStatus('test')).toBe(CacheStatus.MISSING);

      await mount();

      expect(pendingDeferred).toHaveLength(1);
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => pendingDeferred[0].resolve({ key: 'resolved' }));

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(lastRenderedValue).toEqual({ key: 'resolved' });
    });

    it('should handle values that are rejected', async () => {
      expect(suspenseCache.getStatus('test')).toBe(CacheStatus.MISSING);
      await mount();

      expect(pendingDeferred).toHaveLength(1);
      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => {
        try {
          const deferred = pendingDeferred[0];
          deferred.reject('rejected');
          await deferred.promise;
        } catch (error) {}
      });

      expect(lastRenderedValue).toBe('rejected');
      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it('should wait for values that have already been loaded to be resolved', async () => {
      suspenseCache.get('test');
      expect(pendingDeferred).toHaveLength(1);

      await mount();

      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => pendingDeferred[0].resolve({ key: 'resolved' }));

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
      expect(lastRenderedValue).toEqual({ key: 'resolved' });
    });

    it('should wait for values that have already been loaded to be rejected', async () => {
      const value = suspenseCache.get('test');
      if (isPromiseLike(value)) {
        value.then(
          () => {},
          () => {},
        );
      }

      expect(pendingDeferred).toHaveLength(1);

      await mount();

      expect(lastRenderedStatus).toBe(CacheStatus.PENDING);

      await act(async () => {
        try {
          const deferred = pendingDeferred[0];
          deferred.reject('rejected');
          await deferred.promise;
        } catch {}
      });

      expect(lastRenderedValue).toBe('rejected');
      expect(lastRenderedStatus).toBe(CacheStatus.REJECTED);
    });

    it('should show the previous value while a new value is being revalidated', async () => {
      suspenseCache.set({ key: 'resolved' }, 'test');

      await mount();

      expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);

      await act(async () => suspenseCache.invalidate('test'));

      expect(lastRenderedStatus).toBe(CacheStatus.REVALIDATING);
      expect(lastRenderedValue).toEqual({ key: 'resolved' });
    });

    describe('getCache', () => {
      it('should re-fetch a value that has been evicted by the provided cache', async () => {
        // Pre-cache value
        suspenseCache.set({ key: 'test' }, 'test');

        // The LRU cache has a max size of 1, so this should evict the previous
        suspenseCache.set({ key: 'test-2' }, 'test-2');

        // Rendering should trigger a re-fetch
        await mount();

        expect(lastRenderedStatus).toBe(CacheStatus.PENDING);
        expect(lastRenderedValue).toBeUndefined();

        expect(pendingDeferred.length).toBe(1);
        await act(async () => pendingDeferred[0].resolve({ key: 'resolved' }));

        expect(lastRenderedStatus).toBe(CacheStatus.RESOLVED);
        expect(lastRenderedValue).toEqual({ key: 'resolved' });
      });
    });
  });

  describe('cacheResource', () => {
    it('should call the provided resources without the resource key', () => {
      const resourceOneLoad = vi.fn();
      const resourceTwoLoad = vi.fn();

      resourceOneLoad.mockImplementation(defaultLoad);
      resourceTwoLoad.mockImplementation(defaultLoad);

      const resource = {
        '/1': resourceOneLoad,
        '/2': resourceTwoLoad,
      };
      const cache = cacheResource(resource);

      cache.get('/1', 'test', 'keys');
      cache.get('/2', 'test', 'keys');

      expect(resourceOneLoad).toHaveBeenCalledTimes(1);
      expect(resourceTwoLoad).toHaveBeenCalledTimes(1);

      expect(resourceOneLoad).toHaveBeenCalledWith(expect.anything(), 'test', 'keys');
      expect(resourceTwoLoad).toHaveBeenCalledWith(expect.anything(), 'test', 'keys');
    });

    it('should call the provided getKey functions without the resource key', () => {
      const resourceOneLoad = vi.fn();
      const resourceTwoLoad = vi.fn();

      resourceOneLoad.mockImplementation(defaultLoad);
      resourceTwoLoad.mockImplementation(defaultLoad);

      const resource = {
        '/1': resourceOneLoad,
        '/2': resourceTwoLoad,
      };

      const resourceOneGetKey = vi.fn();
      const resourceTwoGetKey = vi.fn();

      resourceOneGetKey.mockImplementation((...args: any[]) => args.join(','));
      resourceTwoGetKey.mockImplementation((...args: any[]) => args.join(','));

      const cache = cacheResource(resource, {
        getKey: {
          '/1': resourceOneGetKey,
          '/2': resourceTwoGetKey,
        },
      });

      cache.get('/1', 'test', 'keys');
      cache.get('/2', 'test', 'keys');

      expect(resourceOneGetKey).toHaveBeenCalledWith('test', 'keys');
      expect(resourceTwoGetKey).toHaveBeenCalledWith('test', 'keys');
    });
  });
});
