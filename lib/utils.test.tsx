/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable no-console */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { SuspenseCache } from './cache';
import { cache } from './cache';
import { ErrorBoundary } from './test-utils';
import type { CacheLoadContext } from './types';
import { CacheStatus } from './types';
import {
  all,
  allProps,
  cacheValueIsMissing,
  cacheValueIsPending,
  cacheValueIsRejected,
  cacheValueIsResolved,
  cacheValueIsRevalidating,
  defer,
  isPromiseLike,
} from './utils';

describe('utils', () => {
  describe('defer', () => {
    it('should return a deferred object', () => {
      const deferred = defer();
      expect(deferred).toHaveProperty('promise');
      expect(deferred).toHaveProperty('resolve');
      expect(deferred).toHaveProperty('reject');
    });

    it('should resolve the promise', async () => {
      const deferred = defer();
      deferred.resolve(1);
      await expect(deferred.promise).resolves.toEqual(1);
    });

    it('should reject the promise', async () => {
      const deferred = defer();
      deferred.reject(1);
      await expect(deferred.promise).rejects.toEqual(1);
    });

    it('should throw if resolve is called more than once', () => {
      const deferred = defer();
      deferred.resolve(1);
      expect(() => deferred.resolve(2)).toThrow();
    });

    it('should throw if reject is called more than once', () => {
      const deferred = defer();
      deferred.reject(1);
      expect(() => deferred.reject(2)).toThrow();
    });
  });

  describe('isPromiseLike', () => {
    it('should return true for a promise', () => {
      expect(isPromiseLike(Promise.resolve())).toBe(true);
    });

    it('should return false for a non-promise', () => {
      expect(isPromiseLike(null)).toBe(false);
      expect(isPromiseLike(undefined)).toBe(false);
      expect(isPromiseLike(1)).toBe(false);
      expect(isPromiseLike('')).toBe(false);
      expect(isPromiseLike({})).toBe(false);
      expect(isPromiseLike([])).toBe(false);
    });
  });

  describe('cacheValueIsMissing', () => {
    it('should return true for missing', () => {
      expect(cacheValueIsMissing(CacheStatus.MISSING)).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(cacheValueIsMissing(CacheStatus.PENDING)).toBe(false);
      expect(cacheValueIsMissing(CacheStatus.REJECTED)).toBe(false);
      expect(cacheValueIsMissing(CacheStatus.RESOLVED)).toBe(false);
      expect(cacheValueIsMissing(CacheStatus.REVALIDATING)).toBe(false);
    });
  });

  describe('cacheValueIsPending', () => {
    it('should return true for pending', () => {
      expect(cacheValueIsPending(CacheStatus.PENDING)).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(cacheValueIsPending(CacheStatus.MISSING)).toBe(false);
      expect(cacheValueIsPending(CacheStatus.REJECTED)).toBe(false);
      expect(cacheValueIsPending(CacheStatus.RESOLVED)).toBe(false);
      expect(cacheValueIsPending(CacheStatus.REVALIDATING)).toBe(false);
    });
  });

  describe('cacheValueIsRejected', () => {
    it('should return true for rejected', () => {
      expect(cacheValueIsRejected(CacheStatus.REJECTED)).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(cacheValueIsRejected(CacheStatus.MISSING)).toBe(false);
      expect(cacheValueIsRejected(CacheStatus.PENDING)).toBe(false);
      expect(cacheValueIsRejected(CacheStatus.RESOLVED)).toBe(false);
      expect(cacheValueIsRejected(CacheStatus.REVALIDATING)).toBe(false);
    });
  });

  describe('cacheValueIsResolved', () => {
    it('should return true for resolved', () => {
      expect(cacheValueIsResolved(CacheStatus.RESOLVED)).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(cacheValueIsResolved(CacheStatus.MISSING)).toBe(false);
      expect(cacheValueIsResolved(CacheStatus.PENDING)).toBe(false);
      expect(cacheValueIsResolved(CacheStatus.REJECTED)).toBe(false);
      expect(cacheValueIsResolved(CacheStatus.REVALIDATING)).toBe(false);
    });
  });

  describe('cacheValueIsRevalidating', () => {
    it('should return true for revalidating', () => {
      expect(cacheValueIsRevalidating(CacheStatus.REVALIDATING)).toBe(true);
    });

    it('should return false for other statuses', () => {
      expect(cacheValueIsRevalidating(CacheStatus.MISSING)).toBe(false);
      expect(cacheValueIsRevalidating(CacheStatus.PENDING)).toBe(false);
      expect(cacheValueIsRevalidating(CacheStatus.REJECTED)).toBe(false);
      expect(cacheValueIsRevalidating(CacheStatus.RESOLVED)).toBe(false);
    });
  });

  describe('all', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let getCacheKey: Mock<[string], string>;
    let lastRenderedResult: string[];
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();

    function Component({ ids }: { ids: string[] }): any {
      lastRenderedResult = all(ids.map((id) => () => suspenseCache.suspend(id)));
      return lastRenderedResult as any;
    }

    function Fallback() {
      fallbackRendered = true;
      return null;
    }

    async function mount(ids: string[]) {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(() => {
        root.render(
          <ErrorBoundary onError={onError}>
            <React.Suspense fallback={<Fallback />}>
              <Component ids={ids} />
            </React.Suspense>
          </ErrorBoundary>,
        );
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, key) => {
        if (key.startsWith('error')) {
          return Promise.reject(key);
        }
        return Promise.resolve(key);
      });

      getCacheKey = vi.fn();
      getCacheKey.mockImplementation((key) => key.toString());

      suspenseCache = cache(fetch, {
        getKey: getCacheKey,
      });

      lastRenderedResult = [];
    });

    it('should render the fallback', async () => {
      await mount(['a', 'b']);
      expect(fallbackRendered).toBe(true);
    });

    it('should render the error boundary if one of the suspenders error', async () => {
      const orig = console.error;
      console.error = vi.fn();
      await mount(['a', 'error']);
      expect(onError).toHaveBeenCalledWith('error');
      console.error = orig;
    });

    it('should return the resolved values', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual(['async-a', 'async-b']);
    });
  });

  describe('allProps', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let getCacheKey: Mock<[string], string>;

    type Result = Record<string, string>;
    let lastRenderedResult: Result;
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();

    function Component({ ids }: { ids: string[] }): any {
      lastRenderedResult = allProps(
        // eslint-disable-next-line compat/compat
        Object.fromEntries(ids.map((id) => [id, () => suspenseCache.suspend(id)])),
      );
      return null;
    }

    function Fallback() {
      fallbackRendered = true;
      return null;
    }

    async function mount(ids: string[]) {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(() => {
        root.render(
          <ErrorBoundary onError={onError}>
            <React.Suspense fallback={<Fallback />}>
              <Component ids={ids} />
            </React.Suspense>
          </ErrorBoundary>,
        );
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, key) => {
        if (key.startsWith('error')) {
          return Promise.reject(key);
        }
        return Promise.resolve(key);
      });

      getCacheKey = vi.fn();
      getCacheKey.mockImplementation((key) => key.toString());

      suspenseCache = cache(fetch, {
        getKey: getCacheKey,
      });

      lastRenderedResult = {};
    });

    it('should render the fallback', async () => {
      await mount(['a', 'b']);
      expect(fallbackRendered).toBe(true);
    });

    it('should render the error boundary if one of the suspenders error', async () => {
      const orig = console.error;
      console.error = vi.fn();
      await mount(['a', 'error']);
      expect(onError).toHaveBeenCalledWith('error');
      console.error = orig;
    });

    it('should return the resolved values', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual({
        'async-a': 'async-a',
        'async-b': 'async-b',
      });
    });
  });
});
