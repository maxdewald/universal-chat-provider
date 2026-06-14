# CLIProxyAPI Model Provider

Expose the chat-capable models from a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server in GitHub
Copilot Chat.

The extension discovers models from CLIProxyAPI, enriches them with context,
output, tool, image, and reasoning metadata, and refreshes the list on startup
and when the local CLIProxyAPI configuration changes. Models with multiple
reasoning levels use VS Code's native
**Thinking Effort** selector; they are not duplicated into separate model
entries.

## Requirements

- CLIProxyAPI running and reachable, by default at `http://127.0.0.1:8317`
- A CLIProxyAPI API key
- VS Code 1.124 or newer
- GitHub Copilot Chat

This extension uses the proposed `chatProvider` and
`languageModelThinkingPart` APIs. Proposed API extensions must be installed
from a VSIX and cannot be published as ordinary Marketplace extensions.

## Setup

1. Start CLIProxyAPI and complete the provider login flow there.
2. Build and package this extension with `pnpm install && pnpm ext:package`.
3. Install the generated VSIX in VS Code Insiders.
4. Start the Extension Development Host or restart VS Code. When the extension
   finds a local config, use the bottom **Import API Key** notification action.
   If no config is found, use its **Configure Connection** action instead.
5. Open Copilot Chat and choose a model under the **CLIProxyAPI** provider.

The API key is stored in VS Code `SecretStorage`. The extension never starts or
stops CLIProxyAPI itself. Model discovery runs immediately at startup when a key
is already stored.

For local instances, the extension watches `config.yaml` and the configured
`auth-dir` for credential changes and refreshes models after a short debounce.
CLIProxyAPI does not expose its internal model-registry events over HTTP, so
remote instances can be refreshed through the command or a settings change.

## Model Metadata

The provider reads CLIProxyAPI's standard and enhanced model-list endpoints.
It reports:

- active and maximum context sizes
- maximum output tokens
- image-input and tool-calling support
- all reported reasoning efforts through the native selector
- streaming text, thinking summaries, tool calls, and usage

VS Code requires custom language model providers to implement
`provideTokenCount`; it does not tokenize arbitrary provider requests itself.
This extension uses `js-tiktoken` with `o200k_base` for local estimates. Exact
server-side usage is still reported by CLIProxyAPI after a response.

## Configurations

<!-- configs -->

| Key                                    | Description                                                                           | Type      | Default                   |
| -------------------------------------- | ------------------------------------------------------------------------------------- | --------- | ------------------------- |
| `modelProvider.baseUrl`                | Base URL of the CLIProxyAPI server.                                                   | `string`  | `"http://127.0.0.1:8317"` |
| `modelProvider.configPath`             | Optional path to CLIProxyAPI config.yaml for credential and model metadata discovery. | `string`  | `""`                      |
| `modelProvider.autoDetectConfig`       | Search common local CLIProxyAPI config locations when no config path is set.          | `boolean` | `true`                    |
| `modelProvider.defaultMaxOutputTokens` | Fallback output-token limit when CLIProxyAPI provides no model-specific value.        | `number`  | `16384`                   |

<!-- configs -->

## Commands

<!-- commands -->

| Command                          | Title                                   |
| -------------------------------- | --------------------------------------- |
| `modelProvider.manage`           | CLIProxyAPI: Manage Provider            |
| `modelProvider.configure`        | CLIProxyAPI: Configure Connection       |
| `modelProvider.importConfig`     | CLIProxyAPI: Import API Key from Config |
| `modelProvider.refresh`          | CLIProxyAPI: Refresh Models             |
| `modelProvider.clearCredentials` | CLIProxyAPI: Clear Stored API Key       |
| `modelProvider.showLogs`         | CLIProxyAPI: Show Logs                  |

<!-- commands -->

## Development

```bash
pnpm install
pnpm vscode:dts
pnpm check
```

Press `F5` from VS Code Insiders to launch the Extension Development Host with
the proposed APIs enabled.

## License

[MIT](./LICENSE.md).
