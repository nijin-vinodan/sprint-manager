import { beforeEach, describe, expect, it, vi } from "vitest";

const fromConnStringMock = vi.fn();

vi.mock("@langchain/langgraph-checkpoint-postgres", () => ({
  PostgresSaver: { fromConnString: fromConnStringMock },
}));

// checkpointer.ts caches its PostgresSaver + setup() promise at module scope,
// so each test needs a fresh module instance to observe fromConnString/setup
// being called (or not called again) in isolation.
async function freshCheckpointerModule() {
  vi.resetModules();
  return import("../../src/server/checkpointer.js");
}

beforeEach(() => {
  fromConnStringMock.mockReset();
});

describe("getCheckpointer", () => {
  it("builds a PostgresSaver from the configured DATABASE_URL and runs setup() once", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    const saver = { setup };
    fromConnStringMock.mockReturnValue(saver);

    const { getCheckpointer } = await freshCheckpointerModule();

    const result = await getCheckpointer();

    expect(result).toBe(saver);
    expect(fromConnStringMock).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("memoizes across concurrent/sequential calls — fromConnString and setup() each fire only once", async () => {
    const setup = vi.fn().mockResolvedValue(undefined);
    fromConnStringMock.mockReturnValue({ setup });

    const { getCheckpointer } = await freshCheckpointerModule();

    const [first, second] = await Promise.all([getCheckpointer(), getCheckpointer()]);
    const third = await getCheckpointer();

    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(fromConnStringMock).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledTimes(1);
  });

  it("caches a setup() rejection forever — every later call re-throws the same error without retrying", async () => {
    const setup = vi.fn().mockRejectedValue(new Error("relation already exists"));
    fromConnStringMock.mockReturnValue({ setup });

    const { getCheckpointer } = await freshCheckpointerModule();

    await expect(getCheckpointer()).rejects.toThrow("relation already exists");
    await expect(getCheckpointer()).rejects.toThrow("relation already exists");

    // Documents current (arguably undesirable) behavior: setup() is never retried.
    expect(setup).toHaveBeenCalledTimes(1);
  });
});
