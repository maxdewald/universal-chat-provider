import type { CancellationToken } from 'vscode'
import type { ProviderModel } from '../src/model'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CancellationTokenSource, Uri } from 'vscode'
import {
  buildCommitMessagePrompt,
  collectChangeContext,
  CommitMessageService,
  normalizeCommitMessage,
} from '../src/commit-message'
import {
  extensions,
  resetVSCodeMock,
  vscodeMock,
  window,
  workspace,
} from './support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('commit message service', () => {
  it('uses the independently configured model, staged changes, and cleans the response', async () => {
    const root = Uri.file('/repo')
    const staged = change('/repo/src/staged.ts')
    const working = change('/repo/src/working.ts')
    const repository = gitRepository(root, {
      indexChanges: [staged],
      workingTreeChanges: [working],
    })
    repository.inputBox.value = 'keep until complete'
    repository.diffIndexWithHEAD.mockResolvedValue('staged diff')
    installGit(repository)

    const selectedModel = model('commit-model', 'Commit Model')
    const provider = providerMock([model('chat-model', 'Chat Model'), selectedModel])
    provider.completeText.mockResolvedValue('```text\nfeat: add commit generation\n```')
    vscodeMock.settings.set('universalChatProvider.commitMessage.model', selectedModel.id)

    await new CommitMessageService(provider).generate(
      root,
      [],
      new CancellationTokenSource().token,
    )

    expect(repository.diffIndexWithHEAD).toHaveBeenCalledWith(staged.uri.fsPath)
    expect(repository.diffWithHEAD).not.toHaveBeenCalled()
    expect(provider.completeText).toHaveBeenCalledWith(
      selectedModel,
      expect.stringContaining('Change scope: staged changes'),
      512,
      expect.any(Object),
    )
    expect(provider.completeText.mock.calls[0]?.[1]).toContain('staged diff')
    expect(provider.completeText.mock.calls[0]?.[1]).not.toContain('working.ts')
    expect(repository.inputBox.value).toBe('feat: add commit generation')
    expect(window.showQuickPick).not.toHaveBeenCalled()
  })

  it('uses the repository selected by the SCM input in a multi-root workspace', async () => {
    const firstRoot = Uri.file('/first')
    const secondRoot = Uri.file('/second')
    const first = gitRepository(firstRoot, { indexChanges: [change('/first/a.ts')] })
    const second = gitRepository(secondRoot, { indexChanges: [change('/second/b.ts')] })
    second.diffIndexWithHEAD.mockResolvedValue('second repository diff')
    installGitRepositories([first, second])
    const selectedModel = model('commit-model', 'Commit Model')
    const provider = providerMock([selectedModel])
    provider.completeText.mockResolvedValue('feat: update second repository')

    await new CommitMessageService(provider).generate(secondRoot)

    expect(first.diffIndexWithHEAD).not.toHaveBeenCalled()
    expect(second.diffIndexWithHEAD).toHaveBeenCalledWith('/second/b.ts')
    expect(second.inputBox.value).toBe('feat: update second repository')
  })

  it('persists explicit selection and automatically selects a sole model', async () => {
    const first = model('first', 'First')
    const second = model('second', 'Second')
    const provider = providerMock([first, second])
    window.showQuickPick.mockImplementationOnce(async (items) => {
      const choices = items as ReadonlyArray<{ model: ProviderModel }>
      return choices[1]
    })

    await expect(new CommitMessageService(provider).selectModel()).resolves.toBe(second)
    expect(vscodeMock.settings.get('universalChatProvider.commitMessage.model')).toBe('second')

    resetVSCodeMock()
    const root = Uri.file('/repo')
    const repository = gitRepository(root, { indexChanges: [change('/repo/a.ts')] })
    repository.diffIndexWithHEAD.mockResolvedValue('diff')
    installGit(repository)
    const soleProvider = providerMock([first])
    soleProvider.completeText.mockResolvedValue('feat: use one model')

    await new CommitMessageService(soleProvider).generate(root)

    expect(vscodeMock.settings.get('universalChatProvider.commitMessage.model')).toBe('first')
    expect(window.showQuickPick).not.toHaveBeenCalled()
  })

  it('reopens model selection when the stored model is unavailable', async () => {
    const root = Uri.file('/repo')
    const repository = gitRepository(root, { indexChanges: [change('/repo/a.ts')] })
    repository.diffIndexWithHEAD.mockResolvedValue('diff')
    installGit(repository)
    const current = model('current', 'Current')
    const provider = providerMock([current, model('other', 'Other')])
    provider.completeText.mockResolvedValue('fix: select current model')
    vscodeMock.settings.set('universalChatProvider.commitMessage.model', 'removed')
    window.showQuickPick.mockImplementationOnce(async (items) => {
      const choices = items as ReadonlyArray<{ model: ProviderModel }>
      return choices[0]
    })

    await new CommitMessageService(provider).generate(root)

    expect(window.showQuickPick).toHaveBeenCalledTimes(1)
    expect(vscodeMock.settings.get('universalChatProvider.commitMessage.model')).toBe('current')
    expect(provider.completeText).toHaveBeenCalledWith(
      current,
      expect.any(String),
      512,
      undefined,
    )
  })

  it('falls back to tracked and untracked changes and applies context limits', async () => {
    const root = Uri.file('/repo')
    const tracked = change('/repo/a.ts')
    const text = change('/repo/new.txt')
    const binary = change('/repo/image.bin')
    const large = change('/repo/large.txt')
    const repository = gitRepository(root, {
      workingTreeChanges: [tracked],
      untrackedChanges: [text, binary, large],
    })
    repository.diffWithHEAD.mockResolvedValue('x'.repeat(25_000))
    workspace.fs.stat.mockImplementation(async uri => ({
      size: uri.fsPath.endsWith('large.txt') ? 30_000 : 10,
    }))
    workspace.fs.readFile.mockImplementation(async uri =>
      uri.fsPath.endsWith('image.bin')
        ? new Uint8Array([1, 0, 2])
        : new TextEncoder().encode('hello\nworld'),
    )

    const context = await collectChangeContext(
      repository,
      [large, tracked, text, binary],
      false,
    )

    expect(context.indexOf('### a.ts')).toBeLessThan(context.indexOf('### image.bin'))
    expect(context).toContain('[Diff truncated at the per-file context limit.]')
    expect(context).toContain('[Binary file content omitted.]')
    expect(context).toContain('[Untracked file content omitted: 30000 bytes exceeds the per-file limit.]')
    expect(context).toContain('+hello\n+world')
  })

  it('marks files omitted by the total context limit', async () => {
    const root = Uri.file('/repo')
    const changes = Array.from({ length: 7 }, (_, index) => change(`/repo/${index}.ts`))
    const repository = gitRepository(root, { indexChanges: changes })
    repository.diffIndexWithHEAD.mockResolvedValue('x'.repeat(20_000))

    const context = await collectChangeContext(repository, changes, true)

    expect(context.length).toBeLessThanOrEqual(100_000)
    expect(context).toMatch(/\[\d additional files omitted because the total context limit was reached\.\]/)
  })

  it('uses custom instructions instead of the Conventional Commits default', () => {
    const custom = buildCommitMessagePrompt({
      branch: 'main',
      context: 'diff',
      instructions: 'Write a one-line sentence in German.',
      staged: false,
    })
    expect(custom).toContain('Write a one-line sentence in German.')
    expect(custom).not.toContain('Conventional Commits')

    const defaults = buildCommitMessagePrompt({
      context: 'diff',
      instructions: '',
      staged: true,
    })
    expect(defaults).toContain('Conventional Commits')
    expect(defaults).toContain('Branch: (detached HEAD)')
  })

  it('preserves the input for conflicts, cancellation, and provider failures', async () => {
    const root = Uri.file('/repo')
    const repository = gitRepository(root, {
      indexChanges: [change('/repo/a.ts')],
      mergeChanges: [change('/repo/conflict.ts')],
    })
    repository.inputBox.value = 'existing'
    installGit(repository)
    const provider = providerMock([model('model', 'Model')])

    await new CommitMessageService(provider).generate(root)
    expect(repository.inputBox.value).toBe('existing')
    expect(provider.completeText).not.toHaveBeenCalled()
    expect(window.showWarningMessage).toHaveBeenCalledWith(
      'Resolve the repository merge conflicts before generating a commit message.',
    )

    repository.state.mergeChanges = []
    repository.diffIndexWithHEAD.mockResolvedValue('diff')
    provider.completeText.mockRejectedValueOnce(new Error('offline'))
    await new CommitMessageService(provider).generate(root)
    expect(repository.inputBox.value).toBe('existing')
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'Could not generate a commit message: offline',
    )

    const token = new CancellationTokenSource()
    provider.completeText.mockImplementationOnce(async () => {
      token.cancel()
      return 'feat: should not be written'
    })
    await new CommitMessageService(provider).generate(root, [], token.token)
    expect(repository.inputBox.value).toBe('existing')
  })

  it('reports missing Git and empty changes without changing input', async () => {
    const provider = providerMock([model('model', 'Model')])
    await new CommitMessageService(provider).generate(Uri.file('/missing'))
    expect(window.showErrorMessage).toHaveBeenCalledWith(
      'The built-in Git extension is not available.',
    )

    resetVSCodeMock()
    const root = Uri.file('/repo')
    const repository = gitRepository(root)
    repository.inputBox.value = 'existing'
    installGit(repository)
    await new CommitMessageService(provider).generate(root)
    expect(window.showInformationMessage).toHaveBeenCalledWith(
      'There are no changes to describe in a commit message.',
    )
    expect(repository.inputBox.value).toBe('existing')
  })
})

describe('commit response normalization', () => {
  it('removes one optional outer fence and keeps multiline messages', () => {
    expect(normalizeCommitMessage('```gitcommit\nfeat: add support\n\nExplain why.\n```'))
      .toBe('feat: add support\n\nExplain why.')
    expect(normalizeCommitMessage(' fix: keep raw text ')).toBe('fix: keep raw text')
    expect(normalizeCommitMessage('```text\n\n```')).toBe('')
  })
})

function providerMock(models: ProviderModel[]) {
  return {
    getModels: vi.fn<
      (interactive: boolean, token?: CancellationToken) => Promise<readonly ProviderModel[]>
    >(async () => models),
    completeText: vi.fn<
      (
        model: ProviderModel,
        prompt: string,
        maxOutputTokens: number,
        token?: CancellationToken,
      ) => Promise<string | undefined>
    >(async () => 'feat: generated message'),
  }
}

function model(id: string, name: string): ProviderModel {
  return {
    id,
    proxyModelId: id,
    name,
    family: 'test',
    version: '1',
    maxInputTokens: 100_000,
    maxOutputTokens: 4096,
    totalContextTokens: 104_096,
    maximumContextTokens: 104_096,
    reasoningLevels: [],
    detail: 'Test model',
    isUserSelectable: true,
    isBYOK: true,
    capabilities: {
      imageInput: false,
      toolCalling: false,
    },
  }
}

function change(path: string) {
  return { uri: Uri.file(path) }
}

function gitRepository(
  rootUri: Uri,
  state: {
    indexChanges?: ReturnType<typeof change>[]
    mergeChanges?: ReturnType<typeof change>[]
    untrackedChanges?: ReturnType<typeof change>[]
    workingTreeChanges?: ReturnType<typeof change>[]
  } = {},
) {
  return {
    rootUri,
    inputBox: { value: '' },
    state: {
      HEAD: { name: 'main' },
      indexChanges: state.indexChanges ?? [],
      mergeChanges: state.mergeChanges ?? [],
      untrackedChanges: state.untrackedChanges ?? [],
      workingTreeChanges: state.workingTreeChanges ?? [],
    },
    ui: { selected: true },
    status: vi.fn(async () => {}),
    diffIndexWithHEAD: vi.fn(async (_path: string) => ''),
    diffWithHEAD: vi.fn(async (_path: string) => ''),
  }
}

function installGit(repository: ReturnType<typeof gitRepository>): void {
  installGitRepositories([repository])
}

function installGitRepositories(repositories: Array<ReturnType<typeof gitRepository>>): void {
  extensions.getExtension.mockReturnValue({
    isActive: true,
    exports: {
      enabled: true,
      getAPI: () => ({
        repositories,
        getRepository: (uri: Uri) =>
          repositories.find(repository => uri.toString() === repository.rootUri.toString()) ?? null,
        openRepository: async () => null,
      }),
    },
  })
}
