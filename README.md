# CLIProxyAPI Model Provider

Expose the chat-capable models from a local
[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) server in GitHub
Copilot Chat, and use those models to generate Git commit messages without a
Copilot subscription.

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

GitHub Copilot Chat is required to expose the models in Chat, but it is not
required for commit-message generation. The commit feature uses VS Code's
built-in Git extension and talks directly to CLIProxyAPI.

This extension uses the proposed `chatProvider`,
`contribSourceControlInputBoxMenu`, and `languageModelThinkingPart` APIs.
Proposed API extensions must be installed from a VSIX and cannot be published
as ordinary Marketplace extensions.

## Setup

1. Start CLIProxyAPI and complete the provider login flow there.
2. Build and package this extension with `pnpm install && pnpm ext:package`.
3. Install the generated VSIX in VS Code Insiders.
4. Start the Extension Development Host or restart VS Code. When the extension
   finds a local config, use the bottom **Import API Key** notification action.
   If no config is found, use its **Configure Connection** action instead.
5. Open Copilot Chat and choose a model under the **CLIProxyAPI** provider.
6. Run **CLIProxyAPI: Select Commit Message Model** to choose the independent
   model used by the Source Control commit-message action.

The API key is stored in VS Code `SecretStorage`. The extension never starts or
stops CLIProxyAPI itself. Model discovery runs immediately at startup when a key
is already stored.

For local instances, the extension watches `config.yaml` and the configured
`auth-dir` for credential changes and refreshes models after a short debounce.
CLIProxyAPI does not expose its internal model-registry events over HTTP, so
remote instances can be refreshed through the command or a settings change.

## Commit Messages

The sparkle action in the Git Source Control input generates a commit message
from staged changes. When nothing is staged, it falls back to tracked and
untracked working-tree changes. The generated message is placed in the input
box for review and is never committed automatically.

Commit-message model selection is independent from Chat. The selected model is
remembered in `modelProvider.commitMessage.model`; if no model is selected, the
extension automatically uses the only available model or opens a live picker.
Use **CLIProxyAPI: Select Commit Message Model** to change it.

By default, the generator requests a concise Conventional Commit. Set
`modelProvider.commitMessage.instructions` to replace that style with
repository-specific instructions. Diff context is bounded per file and per
request, and unresolved merge conflicts must be resolved before generation.

## Model Metadata

The provider reads CLIProxyAPI's standard and enhanced model-list endpoints.
It reports:

- active and maximum context sizes
- maximum output tokens
- image-input and tool-calling support
- all reported reasoning efforts through the native selector
- streaming text, thinking summaries, tool calls, and usage

Chat requests include a stable `prompt_cache_key` derived from the initial chat
seed. CLIProxyAPI uses it for Codex prompt-cache reuse and reasoning replay
cache lookup. The same value is sent as `Session_id` so optional
`session-affinity` auth selection stays sticky without relying on changing
message-history hashes. Cache effectiveness can be checked in the provider
output usage lines; CLIProxyAPI reports cached token counts when the upstream
provider returns them.

VS Code requires custom language model providers to implement
`provideTokenCount`; it does not tokenize arbitrary provider requests itself.
This extension uses `js-tiktoken` with `o200k_base` for local estimates. Exact
server-side usage is still reported by CLIProxyAPI after a response.

## Configurations

<!-- configs -->

| Key                                        | Description                                                                                                                                    | Type      | Default                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------- |
| `modelProvider.baseUrl`                    | Base URL of the CLIProxyAPI server.                                                                                                            | `string`  | `"http://127.0.0.1:8317"` |
| `modelProvider.configPath`                 | Optional path to CLIProxyAPI config.yaml for credential and model metadata discovery.                                                          | `string`  | `""`                      |
| `modelProvider.autoDetectConfig`           | Search common local CLIProxyAPI config locations when no config path is set.                                                                   | `boolean` | `true`                    |
| `modelProvider.defaultMaxOutputTokens`     | Fallback output-token limit when CLIProxyAPI provides no model-specific value.                                                                 | `number`  | `16384`                   |
| `modelProvider.commitMessage.model`        | Model ID used only for commit-message generation. Use the Select Commit Message Model command to choose from currently available models.       | `string`  | `""`                      |
| `modelProvider.commitMessage.instructions` | Optional commit-message instructions. When empty, concise Conventional Commits are generated; when set, these instructions replace that style. | `string`  | `""`                      |

<!-- configs -->

## Commands

<!-- commands -->

| Command                                  | Title                                    |
| ---------------------------------------- | ---------------------------------------- |
| `modelProvider.manage`                   | CLIProxyAPI: Manage Provider             |
| `modelProvider.configure`                | CLIProxyAPI: Configure Connection        |
| `modelProvider.importConfig`             | CLIProxyAPI: Import API Key from Config  |
| `modelProvider.refresh`                  | CLIProxyAPI: Refresh Models              |
| `modelProvider.generateCommitMessage`    | CLIProxyAPI: Generate Commit Message     |
| `modelProvider.selectCommitMessageModel` | CLIProxyAPI: Select Commit Message Model |
| `modelProvider.clearCredentials`         | CLIProxyAPI: Clear Stored API Key        |
| `modelProvider.showLogs`                 | CLIProxyAPI: Show Logs                   |

<!-- commands -->

## Development

```bash
pnpm install
pnpm vscode:dts
pnpm check
```

Press `F5` from VS Code Insiders to launch the Extension Development Host with
the proposed APIs enabled.

### Live provider smoke test

The opt-in E2E suite verifies real streamed messages through the local
CLIProxyAPI server:

```bash
pnpm test:e2e
```

On successful setup this command makes exactly two live model requests, one to
`gpt-5.4-mini` and one to `gemini-3.1-flash-lite`. It is intentionally excluded
from `pnpm test`, `pnpm check`, coverage, and CI because the requests can consume
subscription quota or incur cost.

The test reads the API key from the same automatically discovered CLIProxyAPI
`config.yaml` used by the extension. These environment variables override its
defaults:

| Variable                                | Default                                |
| --------------------------------------- | -------------------------------------- |
| `MODELPROVIDER_E2E_BASE_URL`            | `http://127.0.0.1:8317`                |
| `MODELPROVIDER_E2E_CONFIG_PATH`          | Automatically discovered config        |
| `MODELPROVIDER_E2E_OPENAI_MODEL`         | `gpt-5.4-mini`                         |
| `MODELPROVIDER_E2E_GEMINI_MODEL`         | `gemini-3.1-flash-lite`                |

The suite covers request construction, model discovery, streaming transport,
and SSE parsing. Extension Host registration and Copilot Chat UI behavior
remain covered by unit and manual tests.

## License

[MIT](./LICENSE.md).
