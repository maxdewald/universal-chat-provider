<div align="center">

<img src="res/logo.png" width="132" alt="Universal Chat Provider logo" />

<h1>Universal Chat Provider</h1>

<p>
  <b>The VS&nbsp;Code extension that brings your Claude, ChatGPT&nbsp;/&nbsp;Codex, and Gemini subscriptions into GitHub&nbsp;Copilot&nbsp;Chat</b><br/>
  <sub>No API key — just OAuth&#8209;login the subscriptions you already pay for.</sub><br/>
  <sub>…and use them to write your Git commit messages, too.</sub>
</p>

<p>
  <a href="https://marketplace.visualstudio.com/items?itemName=maxdewald.universal-chat-provider"><img src="https://vsmarketplacebadges.dev/version-short/maxdewald.universal-chat-provider.svg?label=Marketplace&color=654FF0" alt="VS Code Marketplace version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=maxdewald.universal-chat-provider"><img src="https://vsmarketplacebadges.dev/installs-short/maxdewald.universal-chat-provider.svg?label=Installs&color=007ACC" alt="Marketplace installs" /></a>
  <img src="https://img.shields.io/badge/VS%20Code-1.124%2B-007ACC?logo=visualstudiocode&logoColor=white" alt="VS Code 1.124+" />
  <img src="https://img.shields.io/badge/license-MIT-3da639?logo=opensourceinitiative&logoColor=white" alt="MIT License" />
</p>

<p>
  <img src="https://img.shields.io/badge/Claude-D97757?logo=anthropic&logoColor=white" alt="Claude" />
  <img src="https://img.shields.io/badge/Codex-10A37F?logo=data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjZmZmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU%2BT3BlbkFJPC90aXRsZT48cGF0aCBkPSJNMjIuMjgxOSA5LjgyMTFhNS45ODQ3IDUuOTg0NyAwIDAgMC0uNTE1Ny00LjkxMDggNi4wNDYyIDYuMDQ2MiAwIDAgMC02LjUwOTgtMi45QTYuMDY1MSA2LjA2NTEgMCAwIDAgNC45ODA3IDQuMTgxOGE1Ljk4NDcgNS45ODQ3IDAgMCAwLTMuOTk3NyAyLjkgNi4wNDYyIDYuMDQ2MiAwIDAgMCAuNzQyNyA3LjA5NjYgNS45OCA1Ljk4IDAgMCAwIC41MTEgNC45MTA3IDYuMDUxIDYuMDUxIDAgMCAwIDYuNTE0NiAyLjkwMDFBNS45ODQ3IDUuOTg0NyAwIDAgMCAxMy4yNTk5IDI0YTYuMDU1NyA2LjA1NTcgMCAwIDAgNS43NzE4LTQuMjA1OCA1Ljk4OTQgNS45ODk0IDAgMCAwIDMuOTk3Ny0yLjkwMDEgNi4wNTU3IDYuMDU1NyAwIDAgMC0uNzQ3NS03LjA3Mjl6bS05LjAyMiAxMi42MDgxYTQuNDc1NSA0LjQ3NTUgMCAwIDEtMi44NzY0LTEuMDQwOGwuMTQxOS0uMDgwNCA0Ljc3ODMtMi43NTgyYS43OTQ4Ljc5NDggMCAwIDAgLjM5MjctLjY4MTN2LTYuNzM2OWwyLjAyIDEuMTY4NmEuMDcxLjA3MSAwIDAgMSAuMDM4LjA1MnY1LjU4MjZhNC41MDQgNC41MDQgMCAwIDEtNC40OTQ1IDQuNDk0NHptLTkuNjYwNy00LjEyNTRhNC40NzA4IDQuNDcwOCAwIDAgMS0uNTM0Ni0zLjAxMzdsLjE0Mi4wODUyIDQuNzgzIDIuNzU4MmEuNzcxMi43NzEyIDAgMCAwIC43ODA2IDBsNS44NDI4LTMuMzY4NXYyLjMzMjRhLjA4MDQuMDgwNCAwIDAgMS0uMDMzMi4wNjE1TDkuNzQgMTkuOTUwMmE0LjQ5OTIgNC40OTkyIDAgMCAxLTYuMTQwOC0xLjY0NjR6TTIuMzQwOCA3Ljg5NTZhNC40ODUgNC40ODUgMCAwIDEgMi4zNjU1LTEuOTcyOFYxMS42YS43NjY0Ljc2NjQgMCAwIDAgLjM4NzkuNjc2NWw1LjgxNDQgMy4zNTQzLTIuMDIwMSAxLjE2ODVhLjA3NTcuMDc1NyAwIDAgMS0uMDcxIDBsLTQuODMwMy0yLjc4NjVBNC41MDQgNC41MDQgMCAwIDEgMi4zNDA4IDcuODcyem0xNi41OTYzIDMuODU1OEwxMy4xMDM4IDguMzY0IDE1LjExOTIgNy4yYS4wNzU3LjA3NTcgMCAwIDEgLjA3MSAwbDQuODMwMyAyLjc5MTNhNC40OTQ0IDQuNDk0NCAwIDAgMS0uNjc2NSA4LjEwNDJ2LTUuNjc3MmEuNzkuNzkgMCAwIDAtLjQwNy0uNjY3em0yLjAxMDctMy4wMjMxbC0uMTQyLS4wODUyLTQuNzczNS0yLjc4MThhLjc3NTkuNzc1OSAwIDAgMC0uNzg1NCAwTDkuNDA5IDkuMjI5N1Y2Ljg5NzRhLjA2NjIuMDY2MiAwIDAgMSAuMDI4NC0uMDYxNWw0LjgzMDMtMi43ODY2YTQuNDk5MiA0LjQ5OTIgMCAwIDEgNi42ODAyIDQuNjZ6TTguMzA2NSAxMi44NjNsLTIuMDItMS4xNjM4YS4wODA0LjA4MDQgMCAwIDEtLjAzOC0uMDU2N1Y2LjA3NDJhNC40OTkyIDQuNDk5MiAwIDAgMSA3LjM3NTctMy40NTM3bC0uMTQyLjA4MDVMOC43MDQgNS40NTlhLjc5NDguNzk0OCAwIDAgMC0uMzkyNy42ODEzem0xLjA5NzYtMi4zNjU0bDIuNjAyLTEuNDk5OCAyLjYwNjkgMS40OTk4djIuOTk5NGwtMi41OTc0IDEuNDk5Ny0yLjYwNjctMS40OTk3WiIvPjwvc3ZnPg==&logoColor=white" alt="Codex" />
  <img src="https://img.shields.io/badge/Gemini-8E75B2?logo=googlegemini&logoColor=white" alt="Gemini" />
  <img src="https://img.shields.io/badge/Grok-202020?logo=x&logoColor=white" alt="Grok" />
  <img src="https://img.shields.io/badge/Kimi-000000?logo=moonshotai&logoColor=white" alt="Kimi" />
</p>

<p>
  <a href="#features"><b>Features</b></a> &nbsp;·&nbsp;
  <a href="#quick-start"><b>Quick start</b></a> &nbsp;·&nbsp;
  <a href="#supported-logins"><b>Logins</b></a> &nbsp;·&nbsp;
  <a href="#configuration"><b>Configuration</b></a>
</p>

</div>

---

## Features

- **Native model picker** — your subscription models appear under *Universal Chat Provider* in Copilot Chat, with context, output, tool, image, and reasoning metadata.
- **Reasoning support** — models with multiple reasoning levels use VS Code's built-in selector, and emitted reasoning summaries can be shown inline.
- **Utility model** — point Copilot's commit messages, chat titles, and summaries at your subscription models with one command. No Copilot subscription required.
- **Zero setup (managed mode)** — the extension downloads, verifies, and supervises the proxy for you; one shared server across all windows.

## Supported logins

Sign in with any subscription you already have — no API key:

- 🟣 **Claude** — Claude Code / Pro / Max
- 🟢 **Codex** — ChatGPT Plus / Pro
- 🔵 **Gemini** — Gemini CLI
- ⚪ **Grok** — Grok Build
- 🟡 **Kimi** — Moonshot
- ⚫ **Antigravity**

> [!WARNING]
> **Use entirely at your own risk and discretion.** This extension routes chat through your personal AI **subscription** accounts (Claude, ChatGPT / Codex, Gemini, …) over OAuth. Accessing these subscriptions outside their official apps may violate the providers' **Terms of Service** and could result in rate limiting or account suspension. You alone are responsible for how you use it.

## Quick start

> Requires **VS Code 1.124+** and the **GitHub Copilot Chat** extension.

1. **Install** — get *Universal Chat Provider* from the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=maxdewald.universal-chat-provider)**. Prefer to build it yourself? See [Development](#development).
2. **Add an account** — accept the **Add Account** prompt (or run `Universal Chat Provider: Add Account`), pick a provider, and complete OAuth in your browser. Models refresh automatically.
3. **Chat** — open Copilot Chat and select a model under **Universal Chat Provider**.

Manage everything from the status bar item or the *Universal Chat Provider: Manage Provider* command — list/remove accounts, restart, update, or reset the managed server.

<details>
<summary><b>External mode</b> — bring your own CLIProxyAPI server</summary>

<br>

Prefer to run CLIProxyAPI yourself (e.g. a remote or shared instance)?

1. Set `universalChatProvider.server.mode` to `external`.
2. Start CLIProxyAPI and complete the provider login there.
3. Use the **Import API Key** notification action (when a local config is found) or *Configure Connection* to set the URL and key manually.

The API key is stored in VS Code `SecretStorage`. In external mode the extension never starts or stops the server. If your server exposes a plaintext `remote-management.secret-key`, the **Add Account** and **Manage Accounts** commands work against it too.

</details>

## Utility model

Copilot generates commit messages, chat titles, and summaries with its own background models. Run *Universal Chat Provider: Set Utility Model* (or use the status bar menu) to point Copilot's `chat.utilityModel` and `chat.utilitySmallModel` at one of your subscription models instead, so those background flows run through your accounts. No Copilot subscription required. Clear the selection to undo.

## How it works

GitHub Copilot Chat normally only talks to Copilot's own models. This extension bridges that gap: it runs a local [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server, logs you into your AI subscriptions via OAuth, and registers their models as a **native chat provider** in VS Code. Pick them straight from the Copilot model dropdown.

```
   Your subscriptions          Local proxy             VS Code
  ┌────────────────────┐     ┌──────────────┐     ┌──────────────────┐
  │ Claude             │     │              │     │  Copilot Chat    │
  │ ChatGPT / Codex    │──┐  │              │  ┌─▶│   model picker   │
  │ Gemini             │  ├─▶│  CLIProxyAPI │──┤  ├──────────────────┤
  │ Grok · Kimi · …    │──┘  │   (OAuth)    │  └─▶│  Utility model   │
  └────────────────────┘     └──────────────┘     └──────────────────┘
```

## Configuration

<details>
<summary>All settings</summary>

<!-- configs -->

| Key                                            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                     | Type      | Default                   |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------- |
| `universalChatProvider.server.mode`            | How the CLIProxyAPI server is provided. 'managed' runs it for you; 'external' connects to your own instance.                                                                                                                                                                                                                                                                                                                                    | `string`  | `"managed"`               |
| `universalChatProvider.server.version`         | CLIProxyAPI release to run in managed mode. Use a pinned version for reproducible installs, or 'latest' to track new releases.                                                                                                                                                                                                                                                                                                                  | `string`  | `"7.2.5"`                 |
| `universalChatProvider.server.suggestUpdates`  | When a pinned managed server has a newer release within the same major version, offer to update to it. New major versions are never suggested automatically. No effect with 'latest' or in external mode.                                                                                                                                                                                                                                       | `boolean` | `true`                    |
| `universalChatProvider.baseUrl`                | Base URL of the CLIProxyAPI server. Used only in external mode; the managed server picks its own port.                                                                                                                                                                                                                                                                                                                                          | `string`  | `"http://127.0.0.1:8317"` |
| `universalChatProvider.configPath`             | Optional path to CLIProxyAPI config.yaml for credential and model metadata discovery.                                                                                                                                                                                                                                                                                                                                                           | `string`  | `""`                      |
| `universalChatProvider.autoDetectConfig`       | Search common local CLIProxyAPI config locations when no config path is set.                                                                                                                                                                                                                                                                                                                                                                    | `boolean` | `true`                    |
| `universalChatProvider.defaultMaxOutputTokens` | Fallback output-token limit when CLIProxyAPI provides no model-specific value.                                                                                                                                                                                                                                                                                                                                                                  | `number`  | `16384`                   |
| `universalChatProvider.showReasoning`          | Show model reasoning summaries inline when a reasoning model emits them.                                                                                                                                                                                                                                                                                                                                                                        | `boolean` | `true`                    |
| `universalChatProvider.debug`                  | Debug mode: show the live prompt-cache hit rate in the status bar and write per-request diagnostics to debug.jsonl in the extension's global storage — token usage (cache-read vs cache-write vs uncached, with a hit rate), the request message-prefix fingerprints, and the cross-turn prefix diff (what changed since the previous turn, the thing that breaks the cache). Off by default; use it to diagnose caching and rate-limit issues. | `boolean` | `false`                   |

<!-- configs -->

</details>

<details>
<summary>All commands</summary>

<!-- commands -->

| Command                                  | Title                                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------------------ |
| `universalChatProvider.manage`           | Universal Chat Provider: Manage Provider                                             |
| `universalChatProvider.login`            | Universal Chat Provider: Add Account (Login)                                         |
| `universalChatProvider.manageAccounts`   | Universal Chat Provider: Manage Accounts                                             |
| `universalChatProvider.restartServer`    | Universal Chat Provider: Restart Managed Server                                      |
| `universalChatProvider.updateBinary`     | Universal Chat Provider: Update Proxy Binary                                         |
| `universalChatProvider.resetServer`      | Universal Chat Provider: Reset Managed Server                                        |
| `universalChatProvider.configure`        | Universal Chat Provider: Configure Connection                                        |
| `universalChatProvider.importConfig`     | Universal Chat Provider: Import API Key from Config                                  |
| `universalChatProvider.refresh`          | Universal Chat Provider: Refresh Models                                              |
| `universalChatProvider.setUtilityModel`  | Universal Chat Provider: Set Utility Model (commit messages, chat titles, summaries) |
| `universalChatProvider.clearCredentials` | Universal Chat Provider: Clear Stored API Key                                        |
| `universalChatProvider.showLogs`         | Universal Chat Provider: Show Logs                                                   |
| `universalChatProvider.showServerLogs`   | Universal Chat Provider: Show Server Output                                          |
| `universalChatProvider.openSettings`     | Universal Chat Provider: Open Settings                                               |

<!-- commands -->

</details>

## Development

```bash
pnpm install
pnpm vscode:dts
pnpm check          # lint + typecheck + tests + build
pnpm ext:package    # produce an installable .vsix
```

Press `F5` from VS Code Insiders to launch the Extension Development Host with the proposed APIs enabled. The opt-in live smoke test (`pnpm test:e2e`) makes real model requests and is excluded from `pnpm check` and CI because it can consume subscription quota.

## License

[MIT](./LICENSE.md) · Not affiliated with GitHub, OpenAI, Anthropic, or Google.
