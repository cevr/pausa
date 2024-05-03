export function makeKey(args: any[]): string {
  if (args.length === 0) {
    return "()";
  }
  return `(${args.map((arg) => JSON.stringify(arg)).join(":")})`;
}

export const DeferredStatus = {
  PENDING: "pending",
  RESOLVED: "resolved",
  REJECTED: "rejected",
} as const;

export type DeferredStatus =
  (typeof DeferredStatus)[keyof typeof DeferredStatus];

export interface Deferred<Value> {
  promise: Promise<Value>;
  status: DeferredStatus;
  reject(error: any): void;
  resolve(value?: Value | PromiseLike<Value>): void;
}

// a Deferred is a type of Promise that can be resolved or rejected from the outside
// e.g: const deferred = defer<string>(); deferred.resolve('hello'); deferred.promise.then(console.log);
export function defer<Type>(): Deferred<Type> {
  let status: DeferredStatus = DeferredStatus.PENDING;

  let rejectPromise: (error: any) => void;
  let resolvePromise: (value: Type | PromiseLike<Type>) => void;

  const promise = new Promise<Type>((resolve, reject) => {
    rejectPromise = reject;
    resolvePromise = resolve;
  });

  // prevent unhandled rejections
  promise.catch(() => {});

  const deferred: Deferred<Type> = {
    promise,
    status,
    reject: rejectPromise!,
    resolve: resolvePromise!,
  };

  return deferred;
}

export function isPartialKeyMatch(a: any[], b: any[]): boolean;
export function isPartialKeyMatch(a: any, b: any): boolean {
  if (a === b) {
    return true;
  }

  if (typeof a !== typeof b) {
    return false;
  }

  if (a && b && typeof a === "object" && typeof b === "object") {
    return !Object.keys(b).some((key) => !isPartialKeyMatch(a[key], b[key]));
  }

  return false;
}
