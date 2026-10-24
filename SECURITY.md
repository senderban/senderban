# Security policy

Senderban handles mail account credentials and writes rules to mail accounts, so security reports
are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private vulnerability reporting:
**Security → Report a vulnerability** on this repository.

Include what you found, how to reproduce it, and the version or commit. This is a small
volunteer project: expect an acknowledgement within a few days, not hours.

## Scope

In scope: credential handling, rule-writing logic that could block or expose the wrong mail, the
notification action path, and the update/installer pipeline once it exists.

Out of scope: vulnerabilities in a mail provider's own service, and issues that need an attacker
who already controls the user's operating system account.

## Supported versions

There is no release yet. Only the `main` branch is considered.
