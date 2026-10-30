import { AdapterError } from "../../src/adapter.js";
import { stripComments } from "../../src/sieve/syntax.js";
import type { SieveScriptInfo, SieveSession } from "../../src/sieve/session.js";

export const ALL_EXTENSIONS = ["fileinto", "mailbox", "include", "envelope", "variables"];

/** In-memory ManageSieve server: same observable rules as Dovecot where the adapter depends on them. */
export class FakeSieveServer {
  readonly scripts = new Map<string, string>();
  active: string | null = null;
  extensions = new Set(ALL_EXTENSIONS);
  maxScriptBytes = 102_400;
  /** Hooks for failure injection. */
  beforeGet: ((name: string, nth: number) => void) | null = null;
  failSetActiveOnce = false;
  failDelete = false;
  /** Run around commands: a person acting between two commands of a round. `nth` counts from 1. */
  afterPut: (() => void) | null = null;
  beforeList: ((nth: number) => void) | null = null;
  #lists = 0;
  readonly puts: string[] = [];
  /** Every command sent, in order: what a round costs. */
  readonly commands: string[] = [];
  #gets = new Map<string, number>();
  closed = 0;
  destroyed = 0;

  session(): SieveSession {
    return {
      extensions: () => this.extensions,
      listScripts: () => {
        this.commands.push("LISTSCRIPTS");
        this.#lists += 1;
        this.beforeList?.(this.#lists);
        return Promise.resolve(
          [...this.scripts.keys()].map((name): SieveScriptInfo => ({
            name,
            active: name === this.active,
          })),
        );
      },
      getScript: (name) => {
        this.commands.push("GETSCRIPT");
        const nth = (this.#gets.get(name) ?? 0) + 1;
        this.#gets.set(name, nth);
        this.beforeGet?.(name, nth);
        return Promise.resolve(this.scripts.get(name) ?? null);
      },
      haveSpace: (_name, size) => {
        this.commands.push("HAVESPACE");
        return Promise.resolve(size <= this.maxScriptBytes);
      },
      putScript: (name, content) => {
        this.commands.push("PUTSCRIPT");
        this.compile(content);
        this.scripts.set(name, content);
        this.puts.push(name);
        this.afterPut?.();
        return Promise.resolve();
      },
      deleteScript: (name) => {
        this.commands.push("DELETESCRIPT");
        if (this.failDelete) {
          return Promise.reject(new AdapterError("TRANSIENT", "connection dropped"));
        }
        if (name === this.active) {
          return Promise.reject(new AdapterError("REJECTED", "cannot delete the active script"));
        }
        if (!this.scripts.delete(name)) {
          return Promise.reject(new AdapterError("REJECTED", "no such script"));
        }
        return Promise.resolve();
      },
      setActive: (name) => {
        this.commands.push("SETACTIVE");
        if (name === "") {
          this.active = null;
          return Promise.resolve();
        }
        if (this.failSetActiveOnce) {
          this.failSetActiveOnce = false;
          return Promise.reject(new AdapterError("TRANSIENT", "connection dropped"));
        }
        if (!this.scripts.has(name)) {
          return Promise.reject(new AdapterError("REJECTED", "no such script"));
        }
        this.active = name;
        return Promise.resolve();
      },
      close: () => {
        this.closed += 1;
        return Promise.resolve();
      },
      destroy: () => {
        this.destroyed += 1;
      },
    };
  }

  /** The two checks the adapter's ordering depends on: include needs `require` and an existing target. */
  compile(content: string): void {
    const code = stripComments(content) ?? "";
    for (const m of code.matchAll(/(?:^|[;{}\s])include\s+(?::[a-z]+\s+)*"([^"]+)"\s*;/gi)) {
      const target = m[1];
      if (target === undefined || !this.scripts.has(target)) {
        throw new AdapterError("REJECTED", `included script "${target ?? ""}" does not exist`);
      }
      if (!/require\s*(\[[^\]]*)?"include"/i.test(code)) {
        throw new AdapterError("REJECTED", 'unknown command "include" (missing require)');
      }
    }
  }
}
