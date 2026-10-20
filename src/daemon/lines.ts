import type { Socket } from "node:net";

// Newline-framed reader for the wire protocol. node:readline was used before, but it re-emits the
// input socket's errors on its own Interface, and an Interface without an "error" listener turns an
// ECONNRESET into an uncaught exception (it took pi down when the daemon was killed mid-probe).
// This splitter never emits anything but lines; socket errors stay on the socket, where every
// caller already handles them. A trailing partial line is delivered when the socket ends.
export const readLines = (socket: Socket, onLine: (line: string) => void): (() => void) => {
  // Held in an object: a plain `let` closed over here is narrowed to `true` by the compiler.
  const state = { rest: "", active: true };
  // Read through a call: `onLine` may dispose the reader mid-loop, which flow narrowing cannot see.
  const stopped = (): boolean => !state.active;

  const onData = (chunk: Buffer | string): void => {
    if (stopped()) return;
    state.rest += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let nl = state.rest.indexOf("\n");
    while (nl !== -1 && !stopped()) {
      const line = state.rest.slice(0, nl);
      state.rest = state.rest.slice(nl + 1);
      onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
      nl = state.rest.indexOf("\n");
    }
  };
  const onEnd = (): void => {
    if (stopped() || state.rest === "") return;
    const line = state.rest;
    state.rest = "";
    onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
  };

  socket.setEncoding("utf8");
  socket.on("data", onData);
  socket.on("end", onEnd);
  return () => {
    state.active = false;
    socket.off("data", onData);
    socket.off("end", onEnd);
  };
};
