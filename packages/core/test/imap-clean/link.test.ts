import { describe, expect, it, vi } from "vitest";
import { CleanLink } from "../../src/imap-clean/session.js";
import type { CleanMailbox } from "../../src/imap-clean/session.js";

const box = (): CleanMailbox => ({}) as CleanMailbox;

describe("CleanLink", () => {
  it("holds the session that opened last", () => {
    const link = new CleanLink();
    const first = box();
    expect(link.current).toBeNull();
    link.attach(first);
    expect(link.current).toBe(first);
    link.detach(first);
    expect(link.current).toBeNull();
  });

  it("ignores the late close of an older session", () => {
    const link = new CleanLink();
    const old = box();
    const fresh = box();
    link.attach(old);
    link.attach(fresh);
    link.detach(old);
    expect(link.current).toBe(fresh);
  });

  it("keeps the live session when an old login finishes after it and closes", () => {
    const link = new CleanLink();
    const live = box();
    const late = box();
    link.attach(live);
    link.attach(late);
    link.detach(late);
    expect(link.current).toBe(live);
  });

  it("tells its listener about every new session", () => {
    const link = new CleanLink();
    const opened = vi.fn();
    link.onOpen(opened);
    link.attach(box());
    link.attach(box());
    expect(opened).toHaveBeenCalledTimes(2);
  });
});
