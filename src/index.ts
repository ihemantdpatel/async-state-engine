
declare const operationIdBrand: unique symbol;

/**
 * Opaque identifier for a single operation.
 *
 * Branded so that consumers cannot fabricate or do arithmetic on an identifier;
 * the only valid source is the value returned by `start`.
 */
export type OperationId = number & { readonly [operationIdBrand]: "OperationId" };

/** No active operation. */
export interface IdleState {
  readonly status: "idle";
}

/** An operation is in flight. */
export interface LoadingState {
  readonly status: "loading";
  readonly operationId: OperationId;
  readonly startedAt: number;
}

/** The current operation completed successfully. */
export interface SuccessState<TData> {
  readonly status: 'success';
  readonly operationId: OperationId;
  readonly data: TData;
  readonly startedAt: number;
  readonly completedAt: number;
}

/** The current operation failed. */
export interface ErrorState<TError> {
  readonly status: "error";
  readonly operationId: OperationId;
  readonly error: TError;
  readonly startedAt: number;
  readonly completedAt: number;
}

/**
 * The state of an async operation, discriminated on `status`.
 */
export type AsyncState<TData, TError = unknown> =
  | IdleState
  | LoadingState
  | SuccessState<TData>
  | ErrorState<TError>;

/**
 * Receives the new state after an accepted transition.
 *
 * Stale transitions are rejected without notifying, so a listener only ever
 * observes states the controller actually committed.
 */
export type Listener<TData, TError = unknown> = (state: AsyncState<TData, TError>) => void;

/**
 * Removes a listener registered by `subscribe`. Safe to call more than once.
 */
export type Unsubscribe = () => void;

/**
 * Shared across every controller.
 *
 * Idle carries no operation identifier, data, or timestamps, so all idle states
 * are indistinguishable and one instance can serve every `AsyncState<TData, TError>`.
 * The cast is sound for the same reason: the object has no `TData`- or
 * `TError`-shaped property for the type arguments to affect.
 *
 * Frozen because it is shared: without it, one consumer mutating the object
 * returned by `get()` would corrupt the idle state of every other controller.
 * The freeze is shallow by design — it protects the state envelope and never
 * reaches consumer `data` or `error` values, which the package must not touch.
 */
const IDLE = Object.freeze({ status: "idle" }) as AsyncState<never, never>;

/**
 * Creates an isolated async-state controller.
 *
 * Each created controller maintains its own state and operation identity.
 */
export function createAsyncState<TData, TError = unknown>() {
  let state: AsyncState<TData, TError> = IDLE;

  /**
   * Source of operation identity for this controller.
   *
   * Pre-incremented on each `start`, so the first issued id is 1 and no valid
   * id is ever falsy.
   */
  let lastOperationId = 0;

  /**
   * The operation currently authorized to commit a result, or `null` when there
   * is none.
   *
   * This is the sole authority on staleness. It is deliberately independent of
   * the public state: the two diverge whenever an operation is invalidated
   * without the visible status reflecting it. Committing clears it, so an
   * operation may commit at most once.
   */
  let current: { readonly id: OperationId; readonly startedAt: number } | null = null;

  /**
   * Registered listeners, in registration order.
   *
   * A `Set` deduplicates, so subscribing the same function twice registers it
   * once and either returned unsubscribe removes it.
   */
  const listeners = new Set<Listener<TData, TError>>();

  /**
   * Notifies every listener registered at the moment the transition committed.
   *
   * Iterates a snapshot so that subscribing or unsubscribing from inside a
   * listener cannot change who receives the notification in progress; such
   * changes take effect on the next transition.
   *
   * Listener exceptions propagate to the caller rather than being caught, per
   * the specification. The consequence is deliberate but sharp: the state is
   * already committed when listeners run, so a throwing listener aborts the
   * notification loop and every listener after it misses that transition while
   * the state has still changed. Listeners must not throw.
   */
  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener(state);
    }
  };

  return {
    get(): AsyncState<TData, TError> {
      return state;
    },

    start(): OperationId {
      const operationId = ++lastOperationId as OperationId;
      const startedAt = Date.now();

      current = { id: operationId, startedAt };
      state = Object.freeze({
        status: "loading",
        operationId,
        startedAt,
      });
      notify();

      return operationId;
    },

    reset(): void {
      /**
       * Invalidation is unconditional: clearing `current` revokes the authority
       * of any in-flight operation, so a completion arriving after this point is
       * rejected by the `current === null` guard regardless of the id it carries.
       */
      current = null;

      // Idle carries no operation identity, so an already-idle controller is
      // visibly unchanged and, per the notify-on-change rule, stays quiet.
      if (state.status === "idle") return;

      state = IDLE as AsyncState<TData, TError>;
      notify();
    },

    subscribe(listener: Listener<TData, TError>): Unsubscribe {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    success(operationId: OperationId, data: TData): boolean {
      if (current === null || current.id !== operationId) return false;

      state = Object.freeze({
        status: "success",
        operationId,
        data,
        startedAt: current.startedAt,
        completedAt: Date.now(),
      });
      current = null;
      notify();

      return true;
    },

    error(operationId: OperationId, error: TError): boolean {
      if (current === null || current.id !== operationId) return false;

      state = Object.freeze({
        status: "error",
        operationId,
        error,
        startedAt: current.startedAt,
        completedAt: Date.now(),
      });
      current = null;
      notify();

      return true;
    },
  };
}
