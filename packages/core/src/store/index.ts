// Separate entry point: `node:sqlite` must not reach the browser extension through the main index.
export { openDatabase } from "./db.js";
export type { Db } from "./db.js";
export * from "./store.js";
