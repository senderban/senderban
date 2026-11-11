import { z } from "zod";

/**
 * The Help view's links. The page sends one of these words and nothing else; the main process maps it to a fixed
 * address here, so no URL ever travels from the renderer to `shell.openExternal`. "logs" opens the log folder instead.
 * Each address was checked to exist on 2026-11-11: issues on, private vulnerability reporting on (GitHub API
 * `private-vulnerability-reporting` = enabled). The Sponsors page was checked on the same day (GitHub GraphQL
 * `sponsorsListing.isPublic` = true). No Discussions page exists yet, so none is offered.
 */
export const HELP_TARGETS = [
  "issues",
  "security",
  "releases",
  "website",
  "sponsor",
  "logs",
] as const;
export type HelpTarget = (typeof HELP_TARGETS)[number];
export const HelpTargetSchema = z.enum(HELP_TARGETS);

export const HELP_LINKS: Readonly<Record<Exclude<HelpTarget, "logs">, string>> = {
  issues: "https://github.com/senderban/senderban/issues/new",
  security: "https://github.com/senderban/senderban/security/advisories/new",
  releases: "https://github.com/senderban/senderban/releases",
  website: "https://senderban.com/",
  sponsor: "https://github.com/sponsors/AlimKose",
};
