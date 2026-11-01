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
notification action path, and the installer and release pipeline.

Out of scope: vulnerabilities in a mail provider's own service, and issues that need an attacker
who already controls the user's operating system account.

## Sign-in

For Gmail and Outlook, Senderban signs in through your browser and catches the answer itself on this
computer. A mail server account takes a password or key you type into Senderban only. It never asks you
to copy a sign-in address, a code or a `localhost` link into a page, a chat or a mail. Anyone who asks for
that is trying to take over your mailbox.

## Supported versions

Only the latest release and the `main` branch are supported.
