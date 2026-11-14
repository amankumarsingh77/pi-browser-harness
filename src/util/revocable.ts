// A view of an object graph that can be cut off. Every function reached through it (methods, and methods of
// whatever those return) throws once `isRevoked()` is true, and a promise reached through it rejects if it
// settles after the cut. browser_run_script hands a user script such a view of the browser client, so a
// script whose run was aborted cannot keep driving the tab: its next browser call throws and the loop ends.
//
// Values are wrapped lazily, as they are read; plain data passes through as proxies that read like the
// original. Functions run with the unwrapped receiver and arguments, so methods that rely on internal slots
// (Map, Set, class private fields) keep working.

const PROXY_KINDS = new Set(["object", "function"]);

export const revocable = (root: object, isRevoked: () => boolean, revokedError: () => Error): unknown => {
  const toProxy = new WeakMap<object, object>();
  const toTarget = new WeakMap<object, object>();

  const unwrap = (v: unknown): unknown =>
    typeof v === "object" || typeof v === "function" ? (v !== null ? toTarget.get(v) ?? v : v) : v;

  const wrap = (v: unknown): unknown => {
    if (v === null || !PROXY_KINDS.has(typeof v)) return v;
    if (v instanceof Promise) {
      return v.then((settled: unknown) => {
        if (isRevoked()) throw revokedError();
        return wrap(settled);
      }, (e: unknown) => {
        if (isRevoked()) throw revokedError();
        throw e;
      });
    }
    if (typeof v !== "object" && typeof v !== "function") return v;
    const known = toProxy.get(v);
    if (known !== undefined) return known;
    const proxy: object = new Proxy(v, {
      get: (target, key) => wrap(Reflect.get(target, key, target)),
      apply: (target, thisArg: unknown, args: ReadonlyArray<unknown>) => {
        if (isRevoked()) throw revokedError();
        if (typeof target !== "function") throw new TypeError("not a function");
        return wrap(Reflect.apply(target, unwrap(thisArg), args.map(unwrap)));
      },
    });
    toProxy.set(v, proxy);
    toTarget.set(proxy, v);
    return proxy;
  };

  return wrap(root);
};
