import { describe, expect, it } from "vitest";

import { type AsyncState, createAsyncState } from "../src/index.js";

describe("createAsyncState", () => {
  it("starts in idle", () => {
    expect(createAsyncState().get().status).toBe("idle");
  });

  it("returns a stable state reference between transitions", () => {
    const state = createAsyncState();

    expect(state.get()).toBe(state.get());
  });

  it("returns a new state reference after a transition", () => {
    const controller = createAsyncState<string>();
    const before = controller.get();

    controller.start();

    expect(controller.get()).not.toBe(before);
  });

  it("freezes state so a consumer cannot corrupt the shared idle object", () => {
    const first = createAsyncState<string>();
    const second = createAsyncState<string>();

    expect(Object.isFrozen(first.get())).toBe(true);
    expect(() => {
      (first.get() as { status: string }).status = "tampered";
    }).toThrow();
    expect(second.get()).toEqual({ status: "idle" });
  });

  it("freezes committed states", () => {
    const controller = createAsyncState<string>();

    const id = controller.start();
    expect(Object.isFrozen(controller.get())).toBe(true);

    controller.success(id, "done");
    expect(Object.isFrozen(controller.get())).toBe(true);
  });

  it("isolates state between controllers", () => {
    const first = createAsyncState<string>();
    const second = createAsyncState<string>();

    const id = first.start();
    first.success(id, "first-result");

    expect(second.get()).toEqual({ status: "idle" });
  });

  it("works with detached get and subscribe references", () => {
    // useSyncExternalStore(controller.subscribe, controller.get) passes both
    // methods unbound, so neither may depend on the call-site receiver.
    const controller = createAsyncState<string>();
    const { get, subscribe } = controller;
    let calls = 0;

    subscribe(() => {
      calls += 1;
    });
    const id = controller.start();

    expect(calls).toBe(1);
    expect(get().status).toBe("loading");

    controller.success(id, "done");

    expect(get()).toBe(get());
    expect(get()).toMatchObject({ status: "success", data: "done" });
  });
});

describe("start", () => {
  it("moves to loading and records the operation", () => {
    const controller = createAsyncState<string>();

    const id = controller.start();
    const state = controller.get();

    if (state.status !== "loading") {
      throw new Error(`expected loading, got ${state.status}`);
    }

    expect(state.operationId).toBe(id);
    expect(state.startedAt).toBeGreaterThan(0);
  });
});

describe("success", () => {
  it("commits data for the current operation", () => {
    const controller = createAsyncState<{ name: string }>();
    const data = { name: "Ada" };

    const id = controller.start();
    const accepted = controller.success(id, data);
    const state = controller.get();

    expect(accepted).toBe(true);

    if (state.status !== "success") {
      throw new Error(`expected success, got ${state.status}`);
    }

    expect(state.data).toBe(data);
    expect(state.data).toEqual({ name: "Ada" });
    expect(state.operationId).toBe(id);
    expect(state.startedAt).toBeGreaterThan(0);
    expect(state.completedAt).toBeGreaterThan(0);
  });

  it("notifies subscribers on an accepted success", () => {
    const controller = createAsyncState<string>();
    const seen: AsyncState<string>[] = [];

    const id = controller.start();
    controller.subscribe((state) => {
      seen.push(state);
    });
    controller.success(id, "done");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: "success", data: "done" });
  });
});

describe("error", () => {
  it("commits an error for the current operation", () => {
    const controller = createAsyncState<string, Error>();
    const failure = new Error("boom");

    const id = controller.start();
    const accepted = controller.error(id, failure);
    const state = controller.get();

    expect(accepted).toBe(true);

    if (state.status !== "error") {
      throw new Error(`expected error, got ${state.status}`);
    }

    expect(state.error).toBe(failure);
    expect(state.operationId).toBe(id);
    expect(state.startedAt).toBeGreaterThan(0);
    expect(state.completedAt).toBeGreaterThan(0);
  });

  it("preserves a non-Error rejection value", () => {
    const controller = createAsyncState<string, { code: number }>();
    const failure = { code: 404 };

    const id = controller.start();
    controller.error(id, failure);
    const state = controller.get();

    if (state.status !== "error") {
      throw new Error(`expected error, got ${state.status}`);
    }

    expect(state.error).toBe(failure);
    expect(state.error).toEqual({ code: 404 });
  });

  it("notifies subscribers on an accepted error", () => {
    const controller = createAsyncState<string, Error>();
    const failure = new Error("boom");
    const seen: AsyncState<string, Error>[] = [];

    const id = controller.start();
    controller.subscribe((state) => {
      seen.push(state);
    });
    controller.error(id, failure);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: "error", error: failure });
  });
});

describe("reset", () => {
  it("returns to idle and notifies", () => {
    const controller = createAsyncState<string>();
    const seen: AsyncState<string>[] = [];

    const id = controller.start();
    controller.success(id, "done");
    controller.subscribe((state) => {
      seen.push(state);
    });
    controller.reset();

    expect(controller.get()).toEqual({ status: "idle" });
    expect(seen).toEqual([{ status: "idle" }]);
  });

  it("does not notify when already idle", () => {
    const controller = createAsyncState<string>();
    const seen: AsyncState<string>[] = [];

    controller.subscribe((state) => {
      seen.push(state);
    });
    controller.reset();

    expect(seen).toEqual([]);
  });

  it("rejects a success from an operation started before the reset", () => {
    const controller = createAsyncState<string>();

    const a = controller.start();
    controller.reset();

    expect(controller.success(a, "late")).toBe(false);
    expect(controller.get()).toEqual({ status: "idle" });
  });

  it("rejects an error from an operation started before the reset", () => {
    const controller = createAsyncState<string, Error>();

    const a = controller.start();
    controller.reset();

    expect(controller.error(a, new Error("late"))).toBe(false);
    expect(controller.get()).toEqual({ status: "idle" });
  });

  it("does not notify subscribers for a completion rejected by reset", () => {
    const controller = createAsyncState<string>();

    const a = controller.start();
    controller.reset();

    const seen: AsyncState<string>[] = [];
    controller.subscribe((state) => {
      seen.push(state);
    });
    controller.success(a, "late");

    expect(seen).toEqual([]);
  });

  it("allows a fresh operation to commit after a reset", () => {
    const controller = createAsyncState<string>();

    controller.start();
    controller.reset();
    const next = controller.start();

    expect(controller.success(next, "fresh")).toBe(true);
    expect(controller.get()).toMatchObject({ status: "success", data: "fresh" });
  });
});

describe("latest operation wins", () => {
  it("supersedes the older operation on a second start", () => {
    const controller = createAsyncState<string>();

    controller.start();
    const b = controller.start();

    expect(controller.success(b, "B-result")).toBe(true);
  });

  it("ignores a stale success after a newer success committed", () => {
    const controller = createAsyncState<string>();

    const a = controller.start();
    const b = controller.start();
    controller.success(b, "B-result");

    const seen: AsyncState<string>[] = [];
    controller.subscribe((state) => {
      seen.push(state);
    });

    expect(controller.success(a, "A-result")).toBe(false);
    expect(controller.get()).toMatchObject({ status: "success", data: "B-result" });
    expect(seen).toEqual([]);
  });

  it("ignores a stale error after a newer success committed", () => {
    const controller = createAsyncState<string, Error>();

    const a = controller.start();
    const b = controller.start();
    controller.success(b, "B-result");

    const seen: AsyncState<string, Error>[] = [];
    controller.subscribe((state) => {
      seen.push(state);
    });

    expect(controller.error(a, new Error("late"))).toBe(false);
    expect(controller.get()).toMatchObject({ status: "success", data: "B-result" });
    expect(seen).toEqual([]);
  });

  it("ignores a stale success after a newer error committed", () => {
    const controller = createAsyncState<string, Error>();
    const failure = new Error("B failed");

    const a = controller.start();
    const b = controller.start();
    controller.error(b, failure);

    const seen: AsyncState<string, Error>[] = [];
    controller.subscribe((state) => {
      seen.push(state);
    });

    expect(controller.success(a, "A-result")).toBe(false);
    expect(controller.get()).toMatchObject({ status: "error", error: failure });
    expect(seen).toEqual([]);
  });

  it("always favors the newest across many generations", () => {
    const controller = createAsyncState<string>();
    const ids = [
      controller.start(),
      controller.start(),
      controller.start(),
      controller.start(),
      controller.start(),
    ];

    for (const stale of ids.slice(0, 4)) {
      expect(controller.success(stale, "stale")).toBe(false);
    }

    expect(controller.success(ids[4]!, "newest")).toBe(true);
    expect(controller.get()).toMatchObject({ status: "success", data: "newest" });
  });
});

describe("subscribe", () => {
  it("notifies a listener with the new state on an accepted transition", () => {
    const controller = createAsyncState<string>();
    const seen: AsyncState<string>[] = [];

    controller.subscribe((state) => {
      seen.push(state);
    });
    const id = controller.start();

    expect(seen).toHaveLength(1);

    const [state] = seen;

    if (state?.status !== "loading") {
      throw new Error(`expected loading, got ${state?.status}`);
    }

    expect(state.operationId).toBe(id);
  });

  it("does not notify a listener registered after the transition", () => {
    const controller = createAsyncState<string>();

    controller.start();

    const seen: AsyncState<string>[] = [];
    controller.subscribe((state) => {
      seen.push(state);
    });

    expect(seen).toEqual([]);
  });

  it("stops notifying after unsubscribe", () => {
    const controller = createAsyncState<string>();
    let calls = 0;

    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    unsubscribe();
    controller.start();

    expect(calls).toBe(0);
  });

  it("is safe to unsubscribe more than once", () => {
    const controller = createAsyncState<string>();
    let calls = 0;

    const unsubscribe = controller.subscribe(() => {
      calls += 1;
    });
    unsubscribe();

    expect(() => unsubscribe()).not.toThrow();

    controller.start();

    expect(calls).toBe(0);
  });

  it("notifies listeners in registration order, synchronously", () => {
    const controller = createAsyncState<string>();
    const calls: string[] = [];

    controller.subscribe(() => {
      calls.push("a");
    });
    controller.subscribe(() => {
      calls.push("b");
    });
    controller.subscribe(() => {
      calls.push("c");
    });

    controller.start();

    expect(calls).toEqual(["a", "b", "c"]);
  });

  it("propagates a listener exception to the caller", () => {
    const controller = createAsyncState<string>();

    controller.subscribe(() => {
      throw new Error("listener blew up");
    });

    expect(() => controller.start()).toThrow("listener blew up");
  });

  it("commits the transition even when a listener throws", () => {
    const controller = createAsyncState<string>();

    controller.subscribe(() => {
      throw new Error("listener blew up");
    });

    expect(() => controller.start()).toThrow();
    expect(controller.get().status).toBe("loading");
  });

  it("keeps other listeners subscribed when one unsubscribes", () => {
    const controller = createAsyncState<string>();
    let removed = 0;
    let kept = 0;

    const unsubscribe = controller.subscribe(() => {
      removed += 1;
    });
    controller.subscribe(() => {
      kept += 1;
    });
    unsubscribe();
    controller.start();

    expect(removed).toBe(0);
    expect(kept).toBe(1);
  });
});
