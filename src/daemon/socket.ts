import type { Socket } from "node:net";

// destroy() on a socket whose handle is already gone throws; the socket is gone either way.
export const destroyQuietly = (socket: Socket): void => {
  try {
    socket.destroy();
  } catch {
    // Already torn down.
  }
};
