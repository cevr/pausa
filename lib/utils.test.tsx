import { defer, isPartialKeyMatch } from "./utils.js";

describe("utils", () => {
  describe("defer", () => {
    it("should return a deferred object", () => {
      const deferred = defer();
      expect(deferred).toHaveProperty("promise");
      expect(deferred).toHaveProperty("resolve");
      expect(deferred).toHaveProperty("reject");
    });

    it("should resolve the promise", async () => {
      const deferred = defer();
      deferred.resolve(1);
      await expect(deferred.promise).resolves.toEqual(1);
    });

    it("should reject the promise", async () => {
      const deferred = defer();
      deferred.reject(1);
      await expect(deferred.promise).rejects.toEqual(1);
    });
  });

  describe("isPartialKeyMatch", () => {
    it("should return true if the key is a partial match", () => {
      const key1 = ["a", "b", "c"];
      const key2 = ["a", "b"];
      expect(isPartialKeyMatch(key1, key2)).toBe(true);
    });
    it("should return false if the key is not a partial match", () => {
      const key1 = ["a", "b", "c"];
      const key2 = ["a", "c"];
      expect(isPartialKeyMatch(key1, key2)).toBe(false);
    });
    it("should work for empty arrays", () => {
      const key1: any[] = [];
      const key2: any[] = [];
      expect(isPartialKeyMatch(key1, key2)).toBe(true);
    });
    it("should work for non primitive values", () => {
      const key1 = [{ a: 1 }, { b: 2 }];
      const key2 = [{ a: 1 }];
      expect(isPartialKeyMatch(key1, key2)).toBe(true);
    });
    it("should work for complex objects", () => {
      const key1 = [
        {
          a: 1,
          b: {
            c: 1,
            d: 2,
          },
        },
        { e: { f: 1 } },
      ];
      const key2 = [
        {
          a: 1,
          b: {
            c: 1,
          },
        },
      ];
      expect(isPartialKeyMatch(key1, key2)).toBe(true);
    });
  });
});
