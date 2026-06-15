# Universal Chat Provider

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

- VS Code 1.124 or newer
- GitHub Copilot Chat

GitHub Copilot Chat is required to expose the models in Chat, but it is not
required for commit-message generation. The commit feature uses VS Code's
built-in Git extension and talks directly to CLIProxyAPI.

This extension uses the proposed `chatProvider`,
`contribSourceControlInputBoxMenu`, and `languageModelThinkingPart` APIs.
Proposed API extensions must be installed from a VSIX and cannot be published
as ordinary Marketplace extensions.

## Server modes

The provider talks to a CLIProxyAPI server. The `universalChatProvider.server.mode`
setting controls where that server comes from:

- **`managed`** (default): the extension downloads, verifies, runs, and
  supervises a CLIProxyAPI binary for you. Nothing to install. The binary is
  cached under the extension's global storage, secrets are generated
  automatically, and one shared server is reused across all VS Code windows.
- **`external`**: the extension connects to a CLIProxyAPI server you start
  yourself, using `universalChatProvider.baseUrl` and your own API key. This is the way
  to point at a remote or shared instance.

### Managed mode (zero setup)

1. Build and package the extension with `pnpm install && pnpm ext:package`, then
   install the generated VSIX in VS Code Insiders.
2. On first start the extension downloads the platform binary, generates its
   config and keys, and starts the server in the background. Watch the status
   bar item for progress.
3. When no provider accounts are connected yet, accept the **Add Account**
   prompt — or run **Universal Chat Provider: Add Account (Login)** anytime — and pick a
   provider (Gemini, Codex, Claude, Antigravity, Kimi, xAI). The system browser
   opens the provider's OAuth page and the running server captures the
   redirect; the account is saved and models refresh automatically.
4. Open Copilot Chat and choose a model under the **Universal Chat Provider** provider.

Use **Universal Chat Provider: Manage Accounts** to list or remove connected accounts,
**Restart Managed Server** / **Update Proxy Binary** to maintain it, and
**Reset Managed Server** to recreate the generated config and keys.

The downloaded binary defaults to a pinned version (`universalChatProvider.server.version`);
set it to `latest` to track new releases, and use **Update Proxy Binary** to
apply an update. The managed server is launched detached so it keeps running in
the background, and is adopted (not duplicated) by other windows.

### External mode (bring your own server)

1. Set `universalChatProvider.server.mode` to `external`.
2. Start CLIProxyAPI yourself and complete the provider login flow there.
3. Use the bottom **Import API Key** notification action when a local config is
   found, or **Configure Connection** to set the URL and key manually.

The API key is stored in VS Code `SecretStorage`. In external mode the
extension never starts or stops CLIProxyAPI. If your own server sets a plaintext
`remote-management.secret-key`, the **Add Account (Login)** and **Manage
Accounts** commands work against it too.

In managed mode the extension watches its `auth-dir` for credential changes and
refreshes models after a short debounce, so accounts added in-editor or via the
CLI appear without a manual refresh. In external mode, logins completed
in-editor refresh automatically and **Refresh Models** picks up changes made
directly on the server.

## Commit Messages

The sparkle action in the Git Source Control input generates a commit message
from staged changes. When nothing is staged, it falls back to tracked and
untracked working-tree changes. The generated message is placed in the input
box for review and is never committed automatically.

Commit-message model selection is independent from Chat. The selected model is
remembered in `universalChatProvider.commitMessage.model`; if no model is selected, the
extension automatically uses the only available model or opens a live picker.
Use **Universal Chat Provider: Select Commit Message Model** to change it.

By default, the generator requests a concise Conventional Commit. Set
`universalChatProvider.commitMessage.instructions` to replace that style with
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

| Key                                                | Description                                                                                                                                    | Type      | Default                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------- |
| `universalChatProvider.server.mode`                | How the CLIProxyAPI server is provided. 'managed' runs it for you; 'external' connects to your own instance.                                   | `string`  | `"managed"`               |
| `universalChatProvider.server.version`             | CLIProxyAPI release to run in managed mode. Use a pinned version for reproducible installs, or 'latest' to track new releases.                 | `string`  | `"7.2.5"`                 |
| `universalChatProvider.baseUrl`                    | Base URL of the CLIProxyAPI server. Used only in external mode; the managed server picks its own port.                                         | `string`  | `"http://127.0.0.1:8317"` |
| `universalChatProvider.configPath`                 | Optional path to CLIProxyAPI config.yaml for credential and model metadata discovery.                                                          | `string`  | `""`                      |
| `universalChatProvider.autoDetectConfig`           | Search common local CLIProxyAPI config locations when no config path is set.                                                                   | `boolean` | `true`                    |
| `universalChatProvider.defaultMaxOutputTokens`     | Fallback output-token limit when CLIProxyAPI provides no model-specific value.                                                                 | `number`  | `16384`                   |
| `universalChatProvider.commitMessage.model`        | Model ID used only for commit-message generation. Use the Select Commit Message Model command to choose from currently available models.       | `string`  | `""`                      |
| `universalChatProvider.commitMessage.instructions` | Optional commit-message instructions. When empty, concise Conventional Commits are generated; when set, these instructions replace that style. | `string`  | `""`                      |

<!-- configs -->

## Commands

<!-- commands -->

| Command                                          | Title                                                |
| ------------------------------------------------ | ---------------------------------------------------- |
| `universalChatProvider.manage`                   | Universal Chat Provider: Manage Provider             |
| `universalChatProvider.login`                    | Universal Chat Provider: Add Account (Login)         |
| `universalChatProvider.manageAccounts`           | Universal Chat Provider: Manage Accounts             |
| `universalChatProvider.restartServer`            | Universal Chat Provider: Restart Managed Server      |
| `universalChatProvider.updateBinary`             | Universal Chat Provider: Update Proxy Binary         |
| `universalChatProvider.resetServer`              | Universal Chat Provider: Reset Managed Server        |
| `universalChatProvider.configure`                | Universal Chat Provider: Configure Connection        |
| `universalChatProvider.importConfig`             | Universal Chat Provider: Import API Key from Config  |
| `universalChatProvider.refresh`                  | Universal Chat Provider: Refresh Models              |
| `universalChatProvider.generateCommitMessage`    | Universal Chat Provider: Generate Commit Message     |
| `universalChatProvider.selectCommitMessageModel` | Universal Chat Provider: Select Commit Message Model |
| `universalChatProvider.clearCredentials`         | Universal Chat Provider: Clear Stored API Key        |
| `universalChatProvider.showLogs`                 | Universal Chat Provider: Show Logs                   |

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

| Variable                                   | Default                         |
| ------------------------------------------ | ------------------------------- |
| `UNIVERSAL_CHAT_PROVIDER_E2E_BASE_URL`     | `http://127.0.0.1:8317`         |
| `UNIVERSAL_CHAT_PROVIDER_E2E_CONFIG_PATH`  | Automatically discovered config |
| `UNIVERSAL_CHAT_PROVIDER_E2E_OPENAI_MODEL` | `gpt-5.4-mini`                  |
| `UNIVERSAL_CHAT_PROVIDER_E2E_GEMINI_MODEL` | `gemini-3.1-flash-lite`         |

The suite covers request construction, model discovery, streaming transport,
and SSE parsing. Extension Host registration and Copilot Chat UI behavior
remain covered by unit and manual tests.

## License

[MIT](./LICENSE.md).
