import assert from "node:assert/strict";
import { test } from "node:test";
import { createRegistrationTracker, registerTools } from "../../src/registration";

type FakeTool = {
  readonly name: string;
};

type PiSink = {
  readonly pi: object;
  readonly tracker: ReturnType<typeof createRegistrationTracker>;
  readonly calls: string[];
};

const makePi = (): PiSink => ({ pi: {}, tracker: createRegistrationTracker(), calls: [] });

const register = (
  sink: PiSink,
  tools: ReadonlyArray<FakeTool>,
  beforeRegister: (tool: FakeTool) => void = () => undefined,
) => {
  registerTools(sink.tracker, sink.pi, tools, (tool) => {
    beforeRegister(tool);
    sink.calls.push(tool.name);
  });
};

const names = (count: number): FakeTool[] => Array.from({ length: count }, (_, index) => ({ name: `tool_${index}` }));

test("registering the same pi API twice does not duplicate tools", () => {
  const sink = makePi();
  const tools = names(3);

  register(sink, tools);
  register(sink, tools);

  assert.deepEqual(sink.calls, ["tool_0", "tool_1", "tool_2"]);
});

test("different pi APIs each receive the complete tool list", () => {
  const first = makePi();
  const second = makePi();
  const tools = names(2);

  register(first, tools);
  register(second, tools);

  assert.deepEqual(first.calls, ["tool_0", "tool_1"]);
  assert.deepEqual(second.calls, ["tool_0", "tool_1"]);
});

test("tools added after an earlier registration reach the same pi API", () => {
  const sink = makePi();

  register(sink, [{ name: "alpha" }]);
  register(sink, [{ name: "alpha" }, { name: "beta" }]);

  assert.deepEqual(sink.calls, ["alpha", "beta"]);
});

test("a failed register leaves the tool unmarked for the next attempt", () => {
  const sink = makePi();
  const tools = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];
  let shouldFail = true;

  assert.throws(
    () => {
      register(sink, tools, (tool) => {
        if (tool.name === "beta" && shouldFail) throw new Error("beta registration failed");
      });
    },
    /beta registration failed/,
  );
  assert.deepEqual(sink.calls, ["alpha"]);

  shouldFail = false;
  register(sink, tools);

  assert.deepEqual(sink.calls, ["alpha", "beta", "gamma"]);
});

test("a new pi API receives the full tool list after an earlier registration", () => {
  const first = makePi();
  const second = makePi();
  const tools = names(42);

  register(first, tools);
  register(second, tools);

  assert.equal(first.calls.length, 42);
  assert.equal(second.calls.length, 42);
  assert.deepEqual(first.calls, tools.map((tool) => tool.name));
  assert.deepEqual(second.calls, tools.map((tool) => tool.name));
});
