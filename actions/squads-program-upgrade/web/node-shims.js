// Injected by esbuild wherever bundled code uses a bare `Buffer` or `process`,
// as review.mjs and the Solana libraries do (Squads' beet pulls in Node's
// assert and util): the browser has neither global.
export { Buffer } from "buffer";

export const process = {
  browser: true,
  env: {},
  version: "",
  versions: {},
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  emitWarning: () => {},
};
