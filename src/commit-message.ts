import type {
  CancellationToken,
  QuickPickItem,
  Uri,
} from 'vscode'
import type { ProviderModel } from './model'
import { relative } from 'node:path'
import {
  ConfigurationTarget,
  extensions,
  window,
  workspace,
} from 'vscode'

const GIT_EXTENSION_ID = 'vscode.git'
const MAX_FILE_CONTEXT = 20_000
const MAX_TOTAL_CONTEXT = 100_000
const TOTAL_LIMIT_RESERVE = 128
const COMMIT_MESSAGE_OUTPUT_TOKENS = 512

interface GitChange {
  readonly uri: Uri
}

interface GitRepository {
  readonly rootUri: Uri
  readonly inputBox: { value: string }
  readonly state: {
    readonly HEAD: { readonly name?: string } | undefined
    readonly mergeChanges: readonly GitChange[]
    readonly indexChanges: readonly GitChange[]
    readonly workingTreeChanges: readonly GitChange[]
    readonly untrackedChanges: readonly GitChange[]
  }
  status: () => Promise<void>
  diffIndexWithHEAD: (path: string) => Promise<string>
  diffWithHEAD: (path: string) => Promise<string>
}

interface GitAPI {
  readonly repositories: readonly GitRepository[]
  getRepository: (uri: Uri) => GitRepository | null
  openRepository: (uri: Uri) => Promise<GitRepository | null>
}

interface GitExtension {
  readonly enabled: boolean
  getAPI: (version: 1) => GitAPI
}

export interface CommitMessageProvider {
  getModels: (interactive: boolean, token?: CancellationToken) => Promise<readonly ProviderModel[]>
  completeText: (
    model: ProviderModel,
    prompt: string,
    maxOutputTokens: number,
    token?: CancellationToken,
  ) => Promise<string | undefined>
}

interface ModelQuickPickItem extends QuickPickItem {
  readonly model: ProviderModel
}

export class CommitMessageService {
  constructor(private readonly provider: CommitMessageProvider) {}

  async selectModel(): Promise<ProviderModel | undefined> {
    return this.resolveModel(true)
  }

  async generate(
    rootUri?: Uri,
    _resourceContext?: readonly unknown[],
    token?: CancellationToken,
  ): Promise<void> {
    if (token?.isCancellationRequested)
      return

    try {
      const repository = await this.resolveRepository(rootUri)
      if (repository === undefined)
        return

      await repository.status()
      if (token?.isCancellationRequested)
        return

      if (repository.state.mergeChanges.length > 0) {
        void window.showWarningMessage(
          'Resolve the repository merge conflicts before generating a commit message.',
        )
        return
      }

      const staged = repository.state.indexChanges.length > 0
      const changes = staged
        ? repository.state.indexChanges
        : uniqueChanges([
            ...repository.state.workingTreeChanges,
            ...repository.state.untrackedChanges,
          ])
      if (changes.length === 0) {
        void window.showInformationMessage('There are no changes to describe in a commit message.')
        return
      }

      const model = await this.resolveModel(false, token)
      if (model === undefined || token?.isCancellationRequested)
        return

      const context = await collectChangeContext(repository, changes, staged, token)
      if (token?.isCancellationRequested)
        return

      const instructions = workspace
        .getConfiguration('modelProvider', repository.rootUri)
        .get<string>('commitMessage.instructions', '')
        .trim()
      const branch = repository.state.HEAD?.name
      const prompt = buildCommitMessagePrompt({
        context,
        instructions,
        staged,
        ...(branch !== undefined ? { branch } : {}),
      })
      const response = await this.provider.completeText(
        model,
        prompt,
        COMMIT_MESSAGE_OUTPUT_TOKENS,
        token,
      )
      if (response === undefined || token?.isCancellationRequested)
        return

      const message = normalizeCommitMessage(response)
      if (message.length === 0) {
        void window.showWarningMessage('CLIProxyAPI returned an empty commit message.')
        return
      }
      repository.inputBox.value = message
    }
    catch (error) {
      if (!token?.isCancellationRequested) {
        void window.showErrorMessage(
          `Could not generate a commit message: ${errorMessage(error)}`,
        )
      }
    }
  }

  private async resolveModel(
    forcePicker: boolean,
    token?: CancellationToken,
  ): Promise<ProviderModel | undefined> {
    const models = await this.provider.getModels(true, token)
    if (token?.isCancellationRequested)
      return undefined
    if (models.length === 0) {
      void window.showWarningMessage(
        'No CLIProxyAPI models are available. Configure the provider and refresh its models first.',
      )
      return undefined
    }

    const settings = workspace.getConfiguration('modelProvider')
    const configuredId = settings.get<string>('commitMessage.model', '').trim()
    const configuredModel = models.find(model => model.id === configuredId)
    if (!forcePicker && configuredModel !== undefined)
      return configuredModel

    if (!forcePicker && models.length === 1) {
      const model = models[0]!
      await settings.update('commitMessage.model', model.id, ConfigurationTarget.Global)
      return model
    }

    const items: ModelQuickPickItem[] = models.map(model => ({
      label: model.name,
      description: model.id,
      picked: model.id === configuredId,
      model,
      ...(model.detail !== undefined ? { detail: model.detail } : {}),
    }))
    const selected = await window.showQuickPick(items, {
      title: 'Select Commit Message Model',
      placeHolder: 'Choose the CLIProxyAPI model used only for commit messages',
      matchOnDescription: true,
      matchOnDetail: true,
    })
    if (selected === undefined)
      return undefined

    await settings.update('commitMessage.model', selected.model.id, ConfigurationTarget.Global)
    return selected.model
  }

  private async resolveRepository(rootUri?: Uri): Promise<GitRepository | undefined> {
    const extension = extensions.getExtension<GitExtension>(GIT_EXTENSION_ID)
    if (extension === undefined) {
      void window.showErrorMessage('The built-in Git extension is not available.')
      return undefined
    }

    const gitExtension = extension.isActive
      ? extension.exports
      : await extension.activate()
    if (!gitExtension.enabled) {
      void window.showErrorMessage('The built-in Git extension is disabled.')
      return undefined
    }

    const api = gitExtension.getAPI(1)
    if (rootUri !== undefined) {
      return api.getRepository(rootUri)
        ?? await api.openRepository(rootUri)
        ?? showRepositoryNotFound()
    }

    const selected = api.repositories.find(repository =>
      (repository as GitRepository & { ui?: { selected?: boolean } }).ui?.selected,
    )
    if (selected !== undefined)
      return selected
    if (api.repositories.length === 1)
      return api.repositories[0]

    void window.showWarningMessage(
      api.repositories.length === 0
        ? 'No Git repository is open.'
        : 'Run commit-message generation from the Source Control input of the repository to use.',
    )
    return undefined
  }
}

interface CommitPromptOptions {
  branch?: string
  context: string
  instructions: string
  staged: boolean
}

export function buildCommitMessagePrompt(options: CommitPromptOptions): string {
  const style = options.instructions.length > 0
    ? options.instructions
    : [
        'Use the Conventional Commits format: type(optional-scope): concise description.',
        'Use an imperative, lowercase description without a trailing period.',
        'Add a short body only when it explains important motivation or behavior.',
      ].join('\n')

  return [
    'Generate a Git commit message for the changes below.',
    '',
    'Output rules:',
    '- Return only the commit message.',
    '- Do not use Markdown fences, quotations, labels, or explanations.',
    '- Do not invent changes that are absent from the supplied context.',
    '',
    'Style instructions:',
    style,
    '',
    `Branch: ${options.branch ?? '(detached HEAD)'}`,
    `Change scope: ${options.staged ? 'staged changes' : 'working tree changes (nothing is staged)'}`,
    '',
    'Changes:',
    options.context,
  ].join('\n')
}

export async function collectChangeContext(
  repository: GitRepository,
  changes: readonly GitChange[],
  staged: boolean,
  token?: CancellationToken,
): Promise<string> {
  const untracked = new Set(repository.state.untrackedChanges.map(change => change.uri.toString()))
  const sorted = [...changes].sort((a, b) =>
    changePath(repository, a).localeCompare(changePath(repository, b)),
  )
  const chunks: string[] = []
  let length = 0
  let omitted = 0

  for (let index = 0; index < sorted.length; index++) {
    if (token?.isCancellationRequested)
      break

    const change = sorted[index]!
    const path = changePath(repository, change)
    let diff: string
    try {
      diff = untracked.has(change.uri.toString())
        ? await untrackedFileContext(change.uri, path)
        : staged
          ? await repository.diffIndexWithHEAD(change.uri.fsPath)
          : await repository.diffWithHEAD(change.uri.fsPath)
    }
    catch (error) {
      diff = `[Unable to read this change: ${errorMessage(error)}]`
    }

    const chunk = `### ${path}\n${truncateFileContext(diff)}`
    const separatorLength = chunks.length === 0 ? 0 : 2
    if (length + separatorLength + chunk.length > MAX_TOTAL_CONTEXT - TOTAL_LIMIT_RESERVE) {
      omitted = sorted.length - index
      break
    }
    chunks.push(chunk)
    length += separatorLength + chunk.length
  }

  if (omitted > 0)
    chunks.push(`[${omitted} additional file${omitted === 1 ? '' : 's'} omitted because the total context limit was reached.]`)

  return chunks.join('\n\n')
}

export function normalizeCommitMessage(value: string): string {
  const trimmed = value.trim()
  const fenced = /^```(?:text|gitcommit|markdown)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}

function truncateFileContext(value: string): string {
  if (value.length <= MAX_FILE_CONTEXT)
    return value
  const marker = '\n[Diff truncated at the per-file context limit.]'
  return `${value.slice(0, MAX_FILE_CONTEXT - marker.length).trimEnd()}${marker}`
}

async function untrackedFileContext(uri: Uri, path: string): Promise<string> {
  const header = [
    `diff --git a/${path} b/${path}`,
    'new file',
    '--- /dev/null',
    `+++ b/${path}`,
  ].join('\n')
  const stat = await workspace.fs.stat(uri)
  if (stat.size > MAX_FILE_CONTEXT)
    return `${header}\n[Untracked file content omitted: ${stat.size} bytes exceeds the per-file limit.]`

  const data = await workspace.fs.readFile(uri)
  if (data.includes(0))
    return `${header}\n[Binary file content omitted.]`

  const text = new TextDecoder().decode(data)
  const added = text.split(/\r?\n/).map(line => `+${line}`).join('\n')
  return `${header}\n${added}`
}

function changePath(repository: GitRepository, change: GitChange): string {
  const path = relative(repository.rootUri.fsPath, change.uri.fsPath).replaceAll('\\', '/')
  return path.length > 0 ? path : change.uri.fsPath
}

function uniqueChanges(changes: readonly GitChange[]): GitChange[] {
  const seen = new Set<string>()
  return changes.filter((change) => {
    const key = change.uri.toString()
    if (seen.has(key))
      return false
    seen.add(key)
    return true
  })
}

function showRepositoryNotFound(): undefined {
  void window.showErrorMessage('The selected Git repository could not be opened.')
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
