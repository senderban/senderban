import { describe, expect, it } from "vitest";
import { TAIL_REFUSED } from "@senderban/core";
import type { IgnoredReason } from "@senderban/core";
import {
  EXPIRED_NOTICE,
  EXPIRED_NOTICE_GAP_MS,
  ignoredClickHandler,
} from "../src/ignored-click.js";

function setup() {
  let now = 1_000_000;
  const logged: IgnoredReason[] = [];
  const notices: string[] = [];
  const handle = ignoredClickHandler({
    log: (reason) => logged.push(reason),
    notice: (body) => notices.push(body),
    now: () => now,
  });
  return { handle, logged, notices, advance: (ms: number) => (now += ms) };
}

describe("ignoredClickHandler", () => {
  it("tells the person when a refused tail did nothing", () => {
    const { handle, logged, notices } = setup();
    handle(TAIL_REFUSED);
    expect(logged).toEqual([TAIL_REFUSED]);
    expect(notices).toEqual([EXPIRED_NOTICE]);
  });

  it("only logs the other reasons", () => {
    const { handle, logged, notices } = setup();
    handle("not-a-button");
    handle("malformed");
    expect(logged).toEqual(["not-a-button", "malformed"]);
    expect(notices).toEqual([]);
  });

  it("shows one notice per gap, however many refused clicks arrive", () => {
    const { handle, logged, notices, advance } = setup();
    for (let n = 0; n < 20; n++) handle(TAIL_REFUSED);
    expect(logged).toHaveLength(20);
    expect(notices).toHaveLength(1);
    advance(EXPIRED_NOTICE_GAP_MS);
    handle(TAIL_REFUSED);
    expect(notices).toHaveLength(2);
  });

  it("does not throw when the notice fails", () => {
    const handle = ignoredClickHandler({
      log: () => undefined,
      notice: () => {
        throw new Error("no notification service");
      },
    });
    expect(() => {
      handle(TAIL_REFUSED);
    }).not.toThrow();
  });
});
