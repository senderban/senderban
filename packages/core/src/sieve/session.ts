export interface SieveScriptInfo {
  readonly name: string;
  readonly active: boolean;
}

/**
 * The ManageSieve operations the adapter needs (RFC 5804), and nothing else. Implementations
 * throw `AdapterError` (AUTH_REQUIRED, REJECTED, TRANSIENT) and never log credentials.
 */
export interface SieveSession {
  /** Lowercase extension names from the server's `SIEVE` capability line. */
  extensions(): ReadonlySet<string>;
  listScripts(): Promise<readonly SieveScriptInfo[]>;
  /** Null when the script does not exist. */
  getScript(name: string): Promise<string | null>;
  haveSpace(name: string, sizeBytes: number): Promise<boolean>;
  /** Replaces an existing script of that name atomically; the server validates the syntax. */
  putScript(name: string, content: string): Promise<void>;
  /** An empty name deactivates the active script. */
  setActive(name: string): Promise<void>;
  /** The server refuses to delete the active script. */
  deleteScript(name: string): Promise<void>;
  close(): Promise<void>;
}
