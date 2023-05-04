/* eslint-disable no-console */
/* eslint-disable @typescript-eslint/no-floating-promises */
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import type { Mock } from 'vitest';
import { vi } from 'vitest';

import type { SuspenseCache } from './cache';
import { cache, cacheResource } from './cache';
import {
  useMutation,
  useReadAll,
  useReadAllProps,
  useSuspend,
  useSuspendAll,
  useSuspendAllProps,
} from './hooks';
import { ErrorBoundary } from './test-utils';
import type { CacheLoadContext, Deferred } from './types';
import { CacheStatus, MutationStatus } from './types';
import { defer } from './utils';

describe('hooks', () => {
  describe('useMutation', () => {
    let cacheString: SuspenseCache<[string], unknown, string>;
    let cacheNumber: SuspenseCache<[number], unknown, number>;

    let resourceCache: ReturnType<typeof createResourceCache>;

    function createResourceCache() {
      return cacheResource({
        '/1': (_, _x: any) => ({} as any),
        '/2': (_, _x: any) => ({} as any),
      });
    }

    let fetch: Mock<[CacheLoadContext, any], Promise<any> | any>;
    let fetchResourceOne: Mock<[CacheLoadContext, any], Promise<any> | any>;
    let fetchResourceTwo: Mock<[CacheLoadContext, any], Promise<any> | any>;

    let container: HTMLDivElement | null = null;

    let pendingDeferred: Deferred<any>[] = [];
    let pendingResources: Record<string, Deferred<any>> = {};

    async function mount(component: React.ReactNode) {
      container = document.createElement('div');
      const root = createRoot(container);
      await act(async () => {
        root.render(component);
      });
    }

    beforeEach(() => {
      // @ts-ignore
      global.IS_REACT_ACT_ENVIRONMENT = true;

      fetch = vi.fn();
      fetch.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();

        pendingDeferred.push(deferred);

        return deferred.promise;
      });

      fetchResourceOne = vi.fn();
      fetchResourceOne.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();
        pendingResources['/1'] = deferred;
        return deferred.promise;
      });

      fetchResourceTwo = vi.fn();
      fetchResourceTwo.mockImplementation(async (_, _key) => {
        const deferred = defer<any>();
        pendingResources['/2'] = deferred;
        return deferred.promise;
      });

      container = null;

      cacheNumber = cache(fetch);
      cacheString = cache(fetch);
      resourceCache = cacheResource({
        '/1': fetchResourceOne,
        '/2': fetchResourceTwo,
      });

      pendingDeferred = [];
      pendingResources = {};
    });

    it('should return the correct status', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;
      let reset: (() => void) | undefined = undefined;

      const deferredMutator = defer<any>();

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },
          ],
          () => deferredMutator.promise,
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

    it('should invalidate the provided caches on successful mutation', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      cacheString.set('1', '1');
      cacheNumber.set(1, 1);
      resourceCache.set('1', '/1', '1');

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'cacheNumber',
              invalidate: () => cacheNumber.invalidate(1),
            },
            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
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

      expect(cacheString.getStatus('1')).toBe(CacheStatus.REVALIDATING);
      expect(cacheNumber.getStatus(1)).toBe(CacheStatus.REVALIDATING);
      expect(resourceCache.getStatus('/1', '1')).toBe(CacheStatus.REVALIDATING);
    });

    it('should not invalidate the provided caches on failed mutation', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      cacheString.set('1', '1');
      cacheNumber.set(1, 1);
      resourceCache.set('1', '/1', '1');

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'cacheNumber',
              invalidate: () => cacheNumber.invalidate(1),
            },
            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
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
        deferredMutator.reject('reject');
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(cacheString.getStatus('1')).toBe(CacheStatus.RESOLVED);
      expect(cacheNumber.getStatus(1)).toBe(CacheStatus.RESOLVED);
      expect(resourceCache.getStatus('/1', '1')).toBe(CacheStatus.RESOLVED);
    });

    it('should update the provided update caches with the result of the mutation', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      cacheString.set('1', '1');
      cacheNumber.set(1, 1);
      resourceCache.set('1', '/1', '1');

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'cacheNumber',
              invalidate: () => cacheNumber.invalidate(1),
            },
            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
          {
            updates: [
              {
                id: 'cacheString',
                getStatus: () => cacheString.getStatus('1'),
                set: (value) => cacheString.set(value, '1'),
                invalidate: () => cacheString.invalidate('1'),
                peek: () => cacheString.peek('1'),
              },

              {
                id: 'resourceCache',
                getStatus: () => resourceCache.getStatus('/1', '1'),
                invalidate: () => resourceCache.invalidate('/1', '1'),
                peek: () => resourceCache.peek('/1', '1'),
                set: (value) => resourceCache.set(value, '/1', '1'),
              },
            ],
          },
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
        deferredMutator.resolve('resolved');
      });

      expect(status).toBe(MutationStatus.RESOLVED);

      expect(cacheString.get('1')).toBe('resolved');
      expect(resourceCache.get('/1', '1')).toBe('resolved');
      expect(cacheNumber.get(1)).toBe(1);
    });

    it('should optimistically update the provided update caches with the provided value', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      cacheString.set('1', '1');
      cacheNumber.set(1, 1);
      resourceCache.set('1', '/1', '1');

      function MutatingComponent(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'cacheNumber',
              invalidate: () => cacheNumber.invalidate(1),
            },
            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
          {
            updates: [
              {
                id: 'cacheString',
                invalidate: () => cacheString.invalidate('1'),
                getStatus: () => cacheString.getStatus('1'),
                set: (value) => cacheString.set(value, '1'),
                peek: () => cacheString.peek('1'),
              },
              {
                id: 'resourceCache',
                invalidate: () => resourceCache.invalidate('/1', '1'),
                getStatus: () => resourceCache.getStatus('/1', '1'),
                peek: () => resourceCache.peek('/1', '1'),
                set: (value) => resourceCache.set(value, '/1', '1'),
              },
            ],
            optimisticData: 'optimistic',
          },
        );

        status = result.status;
        trigger = result.trigger;

        return null;
      }

      let lastRenderedValue: string | undefined = undefined;
      let renderCount = 0;
      function CacheReadingComponent(): any {
        let [value] = cacheString.read('1');
        lastRenderedValue = value;
        renderCount++;
        return null;
      }

      let lastRenderedResourceValue: string | undefined = undefined;
      let renderResourceCount = 0;
      function ResourceCacheReadingComponent(): any {
        let [value] = resourceCache.read('/1', '1');
        lastRenderedResourceValue = value;
        renderResourceCount++;
        return null;
      }

      await mount(
        <>
          <MutatingComponent />
          <React.Suspense>
            <CacheReadingComponent />
            <ResourceCacheReadingComponent />
          </React.Suspense>
        </>,
      );

      expect(status).toBe(MutationStatus.IDLE);

      await act(async () => {
        trigger!();
      });

      expect(status).toBe(MutationStatus.PENDING);
      expect(lastRenderedValue).toBe('optimistic');
      expect(renderCount).toBe(2);
      expect(lastRenderedResourceValue).toBe('optimistic');
      expect(renderResourceCount).toBe(2);

      expect(cacheString.get('1')).toBe('optimistic');
      expect(resourceCache.get('/1', '1')).toBe('optimistic');
      expect(cacheNumber.get(1)).toBe(1);

      await act(async () => {
        deferredMutator.resolve('new-value');
      });

      expect(status).toBe(MutationStatus.RESOLVED);

      expect(cacheString.get('1')).toBe('new-value');
      expect(resourceCache.get('/1', '1')).toBe('new-value');
      expect(cacheNumber.get(1)).toBe(1);

      expect(lastRenderedValue).toBe('new-value');
      expect(lastRenderedResourceValue).toBe('new-value');
      expect(renderCount).toBe(3);
      expect(renderResourceCount).toBe(3);
    });

    it('should rollback the provided update caches on a failed mutation with an optimistic update', async () => {
      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      cacheString.set('1', '1');
      cacheNumber.set(1, 1);
      resourceCache.set('1', '/1', '1');

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'cacheNumber',
              invalidate: () => cacheNumber.invalidate(1),
            },
            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
          {
            updates: [
              {
                id: 'cacheString',
                getStatus: () => cacheString.getStatus('1'),
                set: (value) => cacheString.set(value, '1'),
                invalidate: () => cacheString.invalidate('1'),
                peek: () => cacheString.peek('1'),
              },

              {
                id: 'resourceCache',
                getStatus: () => resourceCache.getStatus('/1', '1'),
                invalidate: () => resourceCache.invalidate('/1', '1'),
                peek: () => resourceCache.peek('/1', '1'),
                set: (value) => resourceCache.set(value, '/1', '1'),
              },
            ],
            optimisticData: 'optimistic',
          },
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

      expect(cacheString.get('1')).toBe('optimistic');
      expect(resourceCache.get('/1', '1')).toBe('optimistic');
      expect(cacheNumber.get(1)).toBe(1);

      await act(async () => {
        deferredMutator.reject('rejected');
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(cacheString.get('1')).toBe('1');
      expect(resourceCache.get('/1', '1')).toBe('1');
      expect(cacheNumber.get(1)).toBe(1);
    });

    it('should invalidate instead of rollback the provided caches with an optimistic update on a failed mutation if the original status was not resolved', async () => {
      const promise = cacheString.get('1');

      pendingDeferred[0]!.reject('rejected');
      await (promise as Promise<any>).catch(() => {});

      expect(cacheString.getStatus('1')).toBe(CacheStatus.REJECTED);

      let status: MutationStatus | undefined = undefined;
      let trigger: (() => Promise<any>) | undefined = undefined;

      const deferredMutator = defer<any>();

      function Component(): any {
        let result = useMutation(
          [
            {
              id: 'cacheString',
              invalidate: () => cacheString.invalidate('1'),
            },

            {
              id: 'resourceCache',
              invalidate: () => resourceCache.invalidate('/1', '1'),
            },
          ],
          () => deferredMutator.promise,
          {
            updates: [
              {
                id: 'cacheString',
                getStatus: () => cacheString.getStatus('1'),
                set: (value) => cacheString.set(value, '1'),
                invalidate: () => cacheString.invalidate('1'),
                peek: () => cacheString.peek('1'),
              },

              {
                id: 'resourceCache',
                getStatus: () => resourceCache.getStatus('/1', '1'),
                invalidate: () => resourceCache.invalidate('/1', '1'),
                peek: () => resourceCache.peek('/1', '1'),
                set: (value) => resourceCache.set(value, '/1', '1'),
              },
            ],
            optimisticData: 'optimistic',
          },
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
      expect(cacheString.getStatus('1')).toBe(CacheStatus.RESOLVED);
      expect(resourceCache.getStatus('/1', '1')).toBe(CacheStatus.RESOLVED);

      await act(async () => {
        deferredMutator.reject('rejected');
      });

      expect(status).toBe(MutationStatus.REJECTED);

      expect(cacheString.getStatus('1')).toBe(CacheStatus.REVALIDATING);
      expect(resourceCache.getStatus('/1', '1')).toBe(CacheStatus.REVALIDATING);
    });
  });

  describe('useReadAll', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let lastRenderedResult: ReturnType<typeof suspenseCache.read>[];
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();

    function Component({ ids }: { ids: string[] }): any {
      lastRenderedResult = useReadAll(
        ids.map((id) => ({
          getStatus: () => suspenseCache.getStatus(id),
          suspend: () => suspenseCache.suspend(id),
          subscribeToStatus: (cb) => suspenseCache.subscribeToStatus(cb, id),
        })),
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

      suspenseCache = cache(fetch);

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
      expect(lastRenderedResult).toEqual([
        ['async-a', false],
        ['async-b', false],
      ]);
    });

    it('should update when one of the items are revalidating', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual([
        ['async-a', false],
        ['async-b', false],
      ]);

      let deferred: Deferred<any>;
      fetch.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });

      act(() => suspenseCache.invalidate('async-a'));
      expect(lastRenderedResult).toEqual([
        ['async-a', true],
        ['async-b', false],
      ]);
    });
  });

  describe('useReadAllProps', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let lastRenderedResult: Record<string, ReturnType<typeof suspenseCache.read>>;
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();

    function Component({ ids }: { ids: string[] }): any {
      lastRenderedResult = useReadAllProps(
        // eslint-disable-next-line compat/compat
        Object.fromEntries(
          ids.map((id) => [
            id,
            {
              getStatus: () => suspenseCache.getStatus(id),
              suspend: () => suspenseCache.suspend(id),
              subscribeToStatus: (cb) => suspenseCache.subscribeToStatus(cb, id),
            },
          ]),
        ),
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

      suspenseCache = cache(fetch);

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
        'async-a': ['async-a', false],
        'async-b': ['async-b', false],
      });
    });

    it('should update when one of the items are revalidating', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual({
        'async-a': ['async-a', false],
        'async-b': ['async-b', false],
      });

      let deferred: Deferred<any>;
      fetch.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });

      act(() => suspenseCache.invalidate('async-a'));
      expect(lastRenderedResult).toEqual({
        'async-a': ['async-a', true],
        'async-b': ['async-b', false],
      });
    });
  });

  describe('useSuspendAll', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let lastRenderedResult: ReturnType<typeof suspenseCache.suspend>[];
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();
    let renderCount = 0;

    function Component({ ids }: { ids: string[] }): any {
      renderCount++;
      lastRenderedResult = useSuspendAll(
        ids.map((id) => ({
          getStatus: () => suspenseCache.getStatus(id),
          suspend: () => suspenseCache.suspend(id),
          subscribeToStatus: (cb) => suspenseCache.subscribeToStatus(cb, id),
        })),
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

      suspenseCache = cache(fetch);

      lastRenderedResult = [];
      renderCount = 0;
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
      expect(renderCount).toBe(2);
    });

    it('should update when one of the items are revalidating', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual(['async-a', 'async-b']);

      let deferred: Deferred<any>;
      fetch.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });

      act(() => suspenseCache.invalidate('async-a'));
      expect(lastRenderedResult).toEqual(['async-a', 'async-b']);
      expect(renderCount).toBe(3);
    });
  });

  describe('useSuspendAllProps', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let lastRenderedResult: Record<string, ReturnType<typeof suspenseCache.suspend>>;
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();
    let renderCount = 0;

    function Component({ ids }: { ids: string[] }): any {
      renderCount++;
      lastRenderedResult = useSuspendAllProps(
        // eslint-disable-next-line compat/compat
        Object.fromEntries(
          ids.map((id) => [
            id,
            {
              getStatus: () => suspenseCache.getStatus(id),
              suspend: () => suspenseCache.suspend(id),
              subscribeToStatus: (cb) => suspenseCache.subscribeToStatus(cb, id),
            },
          ]),
        ),
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

      suspenseCache = cache(fetch);

      lastRenderedResult = {};
      renderCount = 0;
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
      expect(renderCount).toBe(2);
    });

    it('should update when one of the items are revalidating', async () => {
      await mount(['async-a', 'async-b']);
      expect(lastRenderedResult).toEqual({
        'async-a': 'async-a',
        'async-b': 'async-b',
      });

      let deferred: Deferred<any>;
      fetch.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });

      act(() => suspenseCache.invalidate('async-a'));
      expect(lastRenderedResult).toEqual({
        'async-a': 'async-a',
        'async-b': 'async-b',
      });
      expect(renderCount).toBe(3);
    });
  });

  describe('useSuspend', () => {
    let suspenseCache: SuspenseCache<[string], unknown, string>;
    let fetch: Mock<[CacheLoadContext, string], Promise<string> | string>;
    let lastRenderedResult: ReturnType<typeof suspenseCache.suspend> | undefined;
    let fallbackRendered: boolean = false;
    let onError: Mock<[any], void> = vi.fn();
    let renderCount = 0;

    function Component({ id }: { id: string }): any {
      renderCount++;
      lastRenderedResult = useSuspend(
        // eslint-disable-next-line compat/compat
        {
          suspend: () => suspenseCache.suspend(id),
          subscribeToStatus: (cb) => suspenseCache.subscribeToStatus(cb, id),
        },
      );
      return null;
    }

    function Fallback() {
      fallbackRendered = true;
      return null;
    }

    async function mount(id: string) {
      const container = document.createElement('div');
      const root = createRoot(container);
      await act(() => {
        root.render(
          <ErrorBoundary onError={onError}>
            <React.Suspense fallback={<Fallback />}>
              <Component id={id} />
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

      suspenseCache = cache(fetch);

      lastRenderedResult = undefined;
      renderCount = 0;
    });

    it('should render the fallback', async () => {
      await mount('a');
      expect(fallbackRendered).toBe(true);
    });

    it('should render the error boundary if the suspender errors', async () => {
      const orig = console.error;
      console.error = vi.fn();
      await mount('error');
      expect(onError).toHaveBeenCalledWith('error');
      console.error = orig;
    });

    it('should return the resolved values', async () => {
      await mount('async-a');
      expect(lastRenderedResult).toEqual('async-a');
    });

    it('should update when one of the items are revalidating', async () => {
      await mount('async-a');
      expect(lastRenderedResult).toEqual('async-a');

      let deferred: Deferred<any>;
      fetch.mockImplementation(() => {
        deferred = defer<any>();
        return deferred.promise;
      });

      act(() => suspenseCache.invalidate('async-a'));
      expect(lastRenderedResult).toEqual('async-a');
      expect(renderCount).toEqual(3);
    });
  });
});
