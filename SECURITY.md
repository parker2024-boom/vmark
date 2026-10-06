# Security Policy

## Reporting a vulnerability

Please report security problems **privately**, not in a public issue:

**[Report a vulnerability](https://github.com/xiaolai/vmark/security/advisories/new)** (GitHub private vulnerability reporting)

The link opens GitHub's private vulnerability-reporting form; the report you submit is visible only to you and to the people with access to this repository's security advisories. A useful report says:

- the VMark version (Settings → About) and your operating system,
- what an attacker can do, and what they need in order to do it (a crafted file, a web page, a connected AI client, local access),
- the affected feature and any relevant settings, with the expected and the actual behaviour,
- steps to reproduce, or a proof of concept,
- relevant logs or screenshots, with tokens, API keys, personal data and private document contents removed,
- whether the issue is already public or has a planned disclosure date.

If you are not sure whether something is a security problem, report it privately anyway.

## Supported versions

Only the **latest release** is supported. Fixes ship in a new release; they are not backported to older versions. VMark checks for new releases by default, so please check that the problem still exists in the [latest release](https://github.com/xiaolai/vmark/releases/latest) before reporting.

## What is in scope

Anything in this repository that lets someone cross a boundary VMark is supposed to hold. The parts most worth your attention:

| Area | What it does | Examples of a vulnerability |
|---|---|---|
| MCP bridge | Lets an AI client read and edit documents over a loopback WebSocket | Connecting without the token; reading or writing outside the open workspace or the directories of documents already open in VMark; bypassing a required approval prompt |
| Embedded browser (macOS) | A web browser an AI assistant can drive under your approval, including `execute_js` | An action running without the approval it requires; a page reaching the editor, the app's commands or another site's session |
| Updater | Downloads and installs signed updates | Installing an update that is not signed by VMark; downgrading |
| File handling | Opens, previews, exports and saves files; renders Markdown, HTML, SVG and diagrams | A crafted document that runs script in the app, reads files outside the allowed scope, or overwrites a file you did not choose |
| Integrated terminal and AI providers | Runs your shell and the AI tools you configured | A document or web page causing a command to run; an API key being stored outside the operating system's credential store, or sent anywhere other than the configured provider |

The [privacy page](https://vmark.app/guide/privacy) lists every network connection VMark makes and what it may read on disk; behaviour that contradicts that page is in scope too.

## What is out of scope

- Actions that stay within the scope a VMark approval prompt accurately described and you approved. A misleading prompt, a reused approval, or an action beyond what was approved is in scope.
- Commands you type in the integrated terminal, and behaviour of third-party AI tools (`claude`, `codex` and others) that does not depend on VMark. How VMark launches those tools, what it passes to them and how it handles their output is in scope.
- Problems that need an attacker who already controls your user account or your machine.
- Vulnerabilities in a dependency with no way to reach them through VMark. A reachable one is in scope.

## What to expect

VMark is maintained by one person, and reports are handled on a **best-effort** basis. No response or fix timeline, bug bounty, CVE assignment or coordinated-disclosure process is promised. If practical, please allow time for a possible fix before publishing details.
