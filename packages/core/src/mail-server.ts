/**
 * Who runs a mailbox reached over IMAP and ManageSieve. Everything but the MXroute blacklist is the same on all of them:
 * RFC 5804 is the mechanism, and this table only saves the person from typing a server name.
 */
export const MAIL_SERVERS = ["mxroute", "migadu", "mailbox-org", "purelymail", "other"] as const;
export type MailServer = (typeof MAIL_SERVERS)[number];

/** RFC 5804 §1.8: the port a ManageSieve server listens on. */
export const MANAGESIEVE_PORT = 4190;

export const PRESET_SERVERS = ["migadu", "mailbox-org", "purelymail"] as const;
export type PresetServer = (typeof PRESET_SERVERS)[number];

export interface ServerPreset {
  readonly name: string;
  readonly imapHost: string;
  readonly sieveHost: string;
  /** Shown under the form; empty when there is nothing to say. */
  readonly note: string;
}

/**
 * Host names measured on 2026-10-31 by reading each server's public ManageSieve greeting, without signing in, and on the
 * documents named here. Purelymail: purelymail.com/docs/setup/technical. mailbox.org: kb.mailbox.org names ports 2000 and
 * 4190, not a host. Migadu: no document found. Nothing is measured with a real mailbox on any of the three (ADR 0012).
 */
export const SERVER_PRESETS: Readonly<Record<PresetServer, ServerPreset>> = {
  migadu: {
    name: "Migadu",
    imapHost: "imap.migadu.com",
    sieveHost: "imap.migadu.com",
    note: "",
  },
  "mailbox-org": {
    name: "mailbox.org",
    imapHost: "imap.mailbox.org",
    sieveHost: "imap.mailbox.org",
    note: "",
  },
  purelymail: {
    name: "Purelymail",
    imapHost: "imap.purelymail.com",
    sieveHost: "mailserver.purelymail.com",
    note: "With two-factor sign-in on, use an app password.",
  },
};
