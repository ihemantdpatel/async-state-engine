import { describe, expectTypeOf, it } from "vitest";

import { type AsyncState, createAsyncState } from "../src/index.js";

interface User {
  readonly id: number;
  readonly name: string;
}

interface ApiError {
  readonly code: number;
}

describe("AsyncState", () => {
  it("narrows data on a success status", () => {
    const state = {} as AsyncState<User, ApiError>;

    if (state.status === "success") {
      expectTypeOf(state.data).toEqualTypeOf<User>();
    }
  });

  it("narrows the error on an error status", () => {
    const state = {} as AsyncState<User, ApiError>;

    if (state.status === "error") {
      expectTypeOf(state.error).toEqualTypeOf<ApiError>();
    }
  });

  it("exposes loading metadata without exposing data", () => {
    const state = {} as AsyncState<User, ApiError>;

    if (state.status === "loading") {
      expectTypeOf(state.startedAt).toEqualTypeOf<number>();
      // @ts-expect-error — loading carries no result data
      state.data;
    }
  });

  it("makes data unreachable on an un-narrowed state", () => {
    const state = {} as AsyncState<User, ApiError>;

    // @ts-expect-error — invalid states are unrepresentable without narrowing
    state.data;
  });

  it("defaults the error type to unknown", () => {
    const state = {} as AsyncState<User>;

    if (state.status === "error") {
      expectTypeOf(state.error).toEqualTypeOf<unknown>();
    }
  });

  it("infers state from the controller without casts", () => {
    const controller = createAsyncState<User, ApiError>();

    expectTypeOf(controller.get()).toEqualTypeOf<AsyncState<User, ApiError>>();
  });

  it("reports acceptance as a boolean", () => {
    const controller = createAsyncState<User, ApiError>();
    const id = controller.start();

    expectTypeOf(controller.success(id, { id: 1, name: "Ada" })).toEqualTypeOf<boolean>();
    expectTypeOf(controller.error(id, { code: 404 })).toEqualTypeOf<boolean>();
  });

  it("rejects a fabricated operation id", () => {
    const controller = createAsyncState<User, ApiError>();

    // @ts-expect-error — operation ids are opaque and cannot be invented
    controller.success(1, { id: 1, name: "Ada" });
  });
});
