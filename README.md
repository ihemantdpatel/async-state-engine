# async-state-engine

A tiny, type-safe, framework-agnostic async state manager with built-in protection against stale asynchronous results.

[![CI](https://github.com/ihemantdpatel/async-state-engine/actions/workflows/ci.yml/badge.svg)](https://github.com/ihemantdpatel/async-state-engine/actions/workflows/ci.yml)

> **Status:** early development (`0.x`). The public API is still being validated.

- **Zero runtime dependencies** — nothing else is installed into your tree
- **One job** — only the most recently started operation may commit a result
- **Framework-agnostic** — React, Angular, Vue, Svelte, Solid, Node, Bun, Deno, vanilla TS/JS
- **Seven functions** — `createAsyncState`, `get`, `start`, `success`, `error`, `reset`, `subscribe`
- **ESM-only**, ships TypeScript declarations, `sideEffects: false`

---

## Table of contents

- [The problem](#the-problem)
- [Install](#install)
- [Basic usage](#basic-usage)
- [The race condition it solves](#the-race-condition-it-solves)
- [State model](#state-model)
- [Latest-operation-wins](#latest-operation-wins)
- [Reset semantics](#reset-semantics)
- [Subscription behavior](#subscription-behavior)
- [TypeScript usage](#typescript-usage)
- [API reference](#api-reference)
- [Framework-agnostic usage](#framework-agnostic-usage)
- [Recipes](#recipes)
- [Non-goals](#non-goals)
- [Design decisions](#design-decisions)
- [FAQ](#faq)
- [Contributing](#contributing)
- [License](#license)

---

## The problem

Async operations can finish in a different order from the order in which they started.
When two overlap, the slower one can land last and overwrite the newer result:

```
A starts ──────────────────────────────► A resolves (stale, but last to arrive)
      B starts ──────────► B resolves
```

This is the classic search-as-you-type bug: you type `ca`, then `can`, and the response
for `ca` arrives last — so the UI shows results for a query the user already replaced.

`async-state-engine` provides a small state machine that guarantees **only the most
recently started operation may commit a success or error result**. Late results from
superseded operations are silently ignored: no state change, no subscriber notification.

Note the distinction from cancellation. A superseded operation keeps running — this
package does not abort it, it ignores its result. See [Non-goals](#non-goals).

## Install

```bash
pnpm add async-state-engine
```

```bash
npm install async-state-engine
```

```bash
yarn add async-state-engine
```

**Requirements:** Node.js `>=20` (or any modern browser/runtime). The package is
**ESM-only** — there is no CommonJS build, so `require("async-state-engine")` will not
work. Use `import`, or `await import()` from a CJS file.

## Basic usage

```ts
import { createAsyncState } from "async-state-engine";

const search = createAsyncState<Result[], Error>();

search.subscribe((state) => {
  render(state);
});

async function runSearch(query: string) {
  const operationId = search.start();

  try {
    const results = await fetchResults(query);
    search.success(operationId, results);
  } catch (cause) {
    search.error(operationId, cause as Error);
  }
}
```

The contract is a single rule: **hold on to the id `start()` returns, and pass it back
when the operation completes.** If a newer operation has begun in the meantime, the
commit is rejected and nothing changes.

Rendering is then a plain switch on `status`:

```ts
function render(state: AsyncState<Result[], Error>) {
  switch (state.status) {
    case "idle":    return renderEmpty();
    case "loading": return renderSpinner();
    case "success": return renderResults(state.data);
    case "error":   return renderError(state.error);
  }
}
```

## The race condition it solves

```ts
const state = createAsyncState<string>();

const a = state.start();
const b = state.start();

state.success(b, "B-result"); // → true  (accepted, B is current)
state.success(a, "A-result"); // → false (rejected, A is stale)

state.get(); // { status: "success", data: "B-result", ... }
```

A stale operation can never overwrite a newer result — **in either direction**. All three
of these end with B's result as the final state:

| Sequence                                            | Final state          |
| --------------------------------------------------- | -------------------- |
| A starts → B starts → B succeeds → A succeeds late  | B's success          |
| A starts → B starts → B succeeds → A errors late    | B's success          |
| A starts → B starts → B errors → A succeeds late    | B's error            |

A late `error` cannot clobber a newer `success`, and a late `success` cannot clobber a
newer `error`. This holds across any number of generations — start ten operations and
only the tenth can commit.

## State model

State is a discriminated union on `status`, so invalid combinations cannot be expressed:

| `status`    | Fields                                             |
| ----------- | -------------------------------------------------- |
| `"idle"`    | —                                                  |
| `"loading"` | `operationId`, `startedAt`                         |
| `"success"` | `operationId`, `data`, `startedAt`, `completedAt`  |
| `"error"`   | `operationId`, `error`, `startedAt`, `completedAt` |

```ts
type AsyncState<TData, TError = unknown> =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly operationId: OperationId; readonly startedAt: number }
  | { readonly status: "success"; readonly operationId: OperationId; readonly data: TData;
      readonly startedAt: number; readonly completedAt: number }
  | { readonly status: "error"; readonly operationId: OperationId; readonly error: TError;
      readonly startedAt: number; readonly completedAt: number };
```

There is no `data` on `loading` and no `error` on `success` — not as an optional property
set to `undefined`, but absent from the type entirely. Reading `state.data` without
first narrowing on `status` is a compile error.

### Transitions

| From      | Action                  | To                                  |
| --------- | ----------------------- | ----------------------------------- |
| `idle`    | `start`                 | `loading`                           |
| `loading` | `start`                 | `loading` (new operation supersedes)|
| `success` | `start`                 | `loading`                           |
| `error`   | `start`                 | `loading`                           |
| `loading` | `success(current)`      | `success`                           |
| `loading` | `error(current)`        | `error`                             |
| any       | `reset`                 | `idle`                              |
| any       | stale `success`/`error` | *no change, no notification*        |

### Timestamps

`startedAt` and `completedAt` are milliseconds from `Date.now()`, recorded internally.
On a `success`/`error` state, `startedAt` is carried over from the operation's `start()`
call, so `completedAt - startedAt` is that operation's duration.

Timestamps are **informational only**. They play no part in deciding staleness, so a
clock adjustment cannot cause a stale result to be accepted.

### State objects are frozen

Every state object returned by `get()` is `Object.freeze`d. The freeze is **shallow** by
design: it protects the state envelope and deliberately never reaches into your `data` or
`error` values, which the package must not touch. Your own data's immutability remains
your concern.

## Latest-operation-wins

Staleness is decided by **operation identity**, never by timestamps or ordering
heuristics. Each `start()` issues a new id and makes it the sole authority; committing
with any other id is rejected and returns `false`.

An operation may commit **at most once**. After a commit the id is spent, so a duplicate
completion is rejected exactly like a stale one:

```ts
const id = state.start();
state.success(id, "first");  // → true
state.success(id, "second"); // → false, the id is spent
state.error(id, new Error()); // → false
```

This makes the accept/reject rule total: a commit is accepted **only** when its id is the
one issued by the most recent `start()` *and* that operation has not already committed
*and* no `reset()` has occurred since.

## Reset semantics

`reset()` is an invalidation boundary, not merely a status change:

```ts
const a = state.start();
state.reset();
state.success(a, "late"); // → false, rejected
state.get();              // { status: "idle" }
```

`reset` invalidates in-flight operations **unconditionally** — that part never depends on
the current status. It notifies subscribers only when the visible status actually
changes, so calling `reset()` on an already-idle controller invalidates silently and
fires no notification.

After a reset, the controller is fully usable: a fresh `start()` issues a new id that
commits normally.

## Subscription behavior

```ts
const unsubscribe = state.subscribe((next) => console.log(next.status));
unsubscribe(); // safe to call more than once
```

- Listeners are called **synchronously**, inside the `start`/`success`/`error`/`reset`
  call that caused the transition — there is no microtask or batching layer
- Listeners are called in **registration order**
- `subscribe` does **not** fire on registration — seed with `get()` if you need current state
- Only accepted transitions notify; stale and rejected commits are completely silent
- Subscribing or unsubscribing from inside a listener takes effect on the *next*
  transition, never mid-notification
- Registering the same function reference twice registers it once, and either returned
  unsubscribe removes it

### Listeners must not throw

Per spec, listener exceptions **propagate** rather than being swallowed. The consequence
is deliberate but sharp: state is already committed when listeners run, so a throwing
listener aborts the remaining notifications — later listeners miss that transition even
though the state did change, and the exception surfaces from whichever
`start`/`success`/`error`/`reset` call triggered it.

Handle your own errors inside the listener:

```ts
state.subscribe((next) => {
  try {
    render(next);
  } catch (cause) {
    reportToErrorTracker(cause);
  }
});
```

## TypeScript usage

```ts
const state = createAsyncState<User, ApiError>();

const current = state.get();

if (current.status === "success") {
  current.data;  // User
} else if (current.status === "error") {
  current.error; // ApiError
}
```

The error type defaults to `unknown` — the package never assumes errors are `Error`
instances, and a rejection value of any shape (a string, a `{ code }` object, `null`) is
preserved exactly as given.

Operation ids are an **opaque branded type**. You cannot fabricate one or do arithmetic
on it; the only valid source is what `start()` returned:

```ts
state.success(1, user); // ✗ compile error — ids are opaque
```

`void` and `never` work as data types too, for operations with no meaningful result:

```ts
const save = createAsyncState<void>();
const id = save.start();
save.success(id, undefined);
```

## API reference

### `createAsyncState<TData, TError = unknown>()`

Creates an isolated controller. Each controller has its own state, its own operation
identity counter, and its own listener set — controllers never interact.

Returns an object with the six methods below. The methods do not rely on `this`, so they
are safe to destructure or pass as bare references:

```ts
const { get, start, success, error, reset, subscribe } = createAsyncState<User>();
```

### Methods

| Method                | Returns       | Notes                                                                 |
| --------------------- | ------------- | --------------------------------------------------------------------- |
| `get()`               | `AsyncState`  | Reference-stable between transitions. Never throws.                    |
| `start()`             | `OperationId` | Supersedes any in-flight operation, moves to `loading`, notifies.      |
| `success(id, data)`   | `boolean`     | `true` if accepted, `false` if stale/spent/reset.                      |
| `error(id, error)`    | `boolean`     | `true` if accepted, `false` if stale/spent/reset.                      |
| `reset()`             | `void`        | Invalidates all ids unconditionally; notifies only on visible change.  |
| `subscribe(listener)` | `Unsubscribe` | Synchronous, registration order. Does not fire on registration.        |

`get()` returns the **same object reference** until a transition occurs, which is what
makes it safe to pass directly to React's `useSyncExternalStore` without an infinite
re-render loop.

### Exported types

```ts
import type {
  AsyncState,   // AsyncState<TData, TError = unknown> — the discriminated union
  IdleState,    // { status: "idle" }
  LoadingState, // { status: "loading", operationId, startedAt }
  SuccessState, // SuccessState<TData>
  ErrorState,   // ErrorState<TError>
  OperationId,  // opaque branded number
  Listener,     // (state: AsyncState<TData, TError>) => void
  Unsubscribe,  // () => void
} from "async-state-engine";
```

### Complexity

State transitions are O(1); notification is O(n) in the number of listeners. There are no
timers, no polling, no background tasks, and no asynchronous scheduling anywhere in the
package.

## Framework-agnostic usage

The core has no framework dependency. Every integration is the same `get`/`subscribe`
pair. Framework adapters are deliberately **not** part of this package.

### React

```tsx
import { useSyncExternalStore } from "react";

const controller = createAsyncState<User>();

function Profile() {
  const state = useSyncExternalStore(controller.subscribe, controller.get);

  if (state.status === "loading") return <Spinner />;
  if (state.status === "error") return <ErrorView error={state.error} />;
  if (state.status === "success") return <UserCard user={state.data} />;
  return null;
}
```

### Vue

```ts
import { onScopeDispose, shallowRef } from "vue";

export function useAsyncState<T>(controller: ReturnType<typeof createAsyncState<T>>) {
  const state = shallowRef(controller.get());
  onScopeDispose(controller.subscribe((next) => (state.value = next)));
  return state;
}
```

### Svelte

The controller is already very nearly a Svelte store; only the initial emit differs.

```ts
export const searchStore = {
  subscribe(run: (value: AsyncState<Result[]>) => void) {
    run(controller.get()); // Svelte stores emit on subscribe
    return controller.subscribe(run);
  },
};
```

### Angular

```ts
@Injectable({ providedIn: "root" })
export class UserStore {
  private readonly controller = createAsyncState<User>();
  readonly state = signal(this.controller.get());

  constructor() {
    this.controller.subscribe((next) => this.state.set(next));
  }
}
```

### Vanilla / Node

```ts
const unsubscribe = controller.subscribe((state) => {
  console.log(state.status);
});
```

## Recipes

### Search-as-you-type

```ts
const search = createAsyncState<Result[], Error>();

input.addEventListener("input", async (event) => {
  const query = (event.target as HTMLInputElement).value;

  if (query === "") {
    search.reset(); // also invalidates whatever is in flight
    return;
  }

  const id = search.start();
  try {
    search.success(id, await fetchResults(query));
  } catch (cause) {
    search.error(id, cause as Error);
  }
});
```

### Combining with `AbortController`

This package ignores stale results; it does not cancel them. The two compose cleanly when
you want both:

```ts
let inFlight: AbortController | undefined;

async function load(url: string) {
  inFlight?.abort();          // cancellation — your concern
  inFlight = new AbortController();

  const id = state.start();   // stale-result protection — this package's concern
  try {
    const response = await fetch(url, { signal: inFlight.signal });
    state.success(id, await response.json());
  } catch (cause) {
    state.error(id, cause);
  }
}
```

An aborted `fetch` rejects, so the `catch` runs — but because that operation is already
stale, `state.error(id, cause)` returns `false` and the abort never reaches your UI.

### Ignoring the boolean

`success` and `error` return `boolean` so you *can* observe rejection, but ignoring the
return value is the normal case — rejection is a silent no-op by design:

```ts
if (!state.success(id, data)) {
  metrics.increment("stale_result_discarded");
}
```

## Non-goals

Deliberately out of scope, and not planned for the MVP:

HTTP client, caching, retries, request deduplication, automatic promise execution,
cancellation / `AbortController` integration, persistence, localStorage, framework
bindings or hooks, Redux integration, middleware, plugins, devtools, global state,
optimistic updates, stale-while-revalidate, pagination, infinite scrolling, and
convenience accessors such as `isLoading()` / `getData()`.

The package performs **no network requests, no storage access, no logging of application
data, and no telemetry** of any kind.

## Design decisions

- **Discriminated union over optional fields** — makes invalid states unrepresentable and
  gives real narrowing on `status`, instead of forcing consumers to null-check `data` in
  states where it can never exist.
- **Operation identity, not timestamps** — identity is exact; wall-clock comparison is
  not. Clocks jump, and two operations can start within the same millisecond. Timestamps
  are exposed for display, never consulted for correctness.
- **Ignore stale results rather than cancel** — cancellation is a transport concern
  (`AbortController`, database driver, message queue) and varies per transport. This
  package stays transport-agnostic and composes with whatever you use.
- **Reject rather than throw** — a stale completion is an expected, routine outcome of
  overlapping work, not an exceptional condition. It returns `false`.
- **No framework dependency** — the same primitive serves every framework through
  `get`/`subscribe`; adapters belong in separate packages so the core has no release
  coupling to any framework's version cycle.
- **No caching or automatic promise execution** — those are separate problems with their
  own large design spaces (keys, invalidation, GC, revalidation). Bundling them would
  make this package neither small nor focused.
- **Small API** — seven functions, no aliases, no convenience accessors. Consumers
  inspect the union directly, which is both smaller to learn and better-typed.
- **Consumer data is never touched** — no mutation, cloning, transformation, or
  serialization. State envelopes are frozen; your values pass through by reference.
- **Zero runtime dependencies** — enforced in CI, not just intended.

## FAQ

**Does this cancel my in-flight request?**
No. The superseded request keeps running to completion; its result is discarded. Pair it
with `AbortController` if you need actual cancellation — see [Recipes](#recipes).

**Can I use one controller for several independent operations?**
No — a controller models one operation slot. Create one controller per independently
tracked operation.

**Why doesn't `subscribe` fire immediately with the current state?**
Because the initial value is already available synchronously via `get()`, and firing on
registration would make `useSyncExternalStore` and similar integrations awkward. Call
`get()` yourself if you need to seed.

**Is it safe across Web Workers or processes?**
The controller is in-memory and single-realm. Operation identity is per-controller, so
there is nothing to synchronize — and nothing that works across realm boundaries.

**Does it work with CommonJS?**
Not via `require`. The package is ESM-only; use `await import("async-state-engine")` from
CJS.

**How large is it?**
A single small module with zero dependencies, tree-shakeable (`sideEffects: false`).

## Contributing

```bash
pnpm install
pnpm test        # unit + type tests (vitest)
pnpm typecheck   # tsc --noEmit, strict
pnpm build       # tsup → dist/ with declarations
```

CI runs on Node 20, 22, and 24, and additionally asserts zero runtime dependencies and
verifies the published tarball via `pnpm pack` and `pnpm publish --dry-run`.

The behavior described in this README is the contract — in particular the
[latest-operation-wins](#latest-operation-wins) and [reset](#reset-semantics) semantics,
which are governed by an internal specification and covered by the test suite. Changes
that alter those semantics need discussion first, so please open an issue rather than a
pull request for anything in that area.

## License

MIT
