import { vi } from 'vitest'

type Listener<T> = (value: T) => void

class MockDisposable {
  disposed = false

  constructor(private readonly callback: () => void = () => {}) {}

  dispose(): void {
    if (this.disposed)
      return
    this.disposed = true
    this.callback()
  }
}

export class EventEmitter<T> {
  private readonly listeners = new Set<Listener<T>>()
  readonly event = (listener: Listener<T>): MockDisposable => {
    this.listeners.add(listener)
    return new MockDisposable(() => this.listeners.delete(listener))
  }

  fire(value: T): void {
    for (const listener of this.listeners)
      listener(value)
  }

  dispose(): void {
    this.listeners.clear()
  }
}

export class CancellationTokenSource {
  private readonly emitter = new EventEmitter<void>()
  token = {
    isCancellationRequested: false,
    onCancellationRequested: this.emitter.event,
  }

  cancel(): void {
    this.token.isCancellationRequested = true
    this.emitter.fire()
  }

  dispose(): void {
    this.emitter.dispose()
  }
}

export enum LanguageModelChatMessageRole {
  User = 1,
  Assistant = 2,
}

export enum LanguageModelChatToolMode {
  Auto = 1,
  Required = 2,
}

export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}

export enum ProgressLocation {
  Notification = 15,
}

export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}

export class RelativePattern {
  constructor(
    readonly base: unknown,
    readonly pattern: string,
  ) {}
}

export class Uri {
  static file(fsPath: string): Uri {
    return new Uri('file', fsPath)
  }

  static parse(value: string): Uri {
    return new Uri('parsed', value)
  }

  readonly path: string

  constructor(
    readonly scheme: string,
    readonly fsPath: string,
  ) {
    this.path = fsPath
  }

  toString(): string {
    return `${this.scheme}://${this.fsPath}`
  }
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelDataPart {
  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mimeType)
  }

  static text(value: string, mimeType = 'text/plain'): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType)
  }

  static json(value: unknown, mimeType = 'application/json'): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(value)), mimeType)
  }

  constructor(
    readonly data: Uint8Array,
    readonly mimeType: string,
  ) {}
}

export class LanguageModelToolCallPart {
  constructor(
    readonly callId: string,
    readonly name: string,
    readonly input: object,
  ) {}
}

export class LanguageModelToolResultPart {
  constructor(
    readonly callId: string,
    readonly content: unknown[],
  ) {}
}

export class LanguageModelError extends Error {
  static NoPermissions(message = 'No permissions'): LanguageModelError {
    return new LanguageModelError(message, 'NoPermissions')
  }

  static Blocked(message = 'Blocked'): LanguageModelError {
    return new LanguageModelError(message, 'Blocked')
  }

  static NotFound(message = 'Not found'): LanguageModelError {
    return new LanguageModelError(message, 'NotFound')
  }

  private constructor(message: string, readonly code: string) {
    super(message)
  }
}

const settings = new Map<string, unknown>()
const secrets = new Map<string, string>()
const commandHandlers = new Map<string, (...args: unknown[]) => unknown>()

export const vscodeMock = {
  settings,
  secrets,
  commandHandlers,
  registeredProviders: [] as Array<{ vendor: string, provider: unknown }>,
  output: {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  },
}

export const statusBarItem = {
  text: '',
  tooltip: '' as string | undefined,
  command: undefined as string | undefined,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
}

function createWatcher(): { onDidCreate: () => MockDisposable, onDidChange: () => MockDisposable, onDidDelete: () => MockDisposable, dispose: () => void } {
  return {
    onDidCreate: () => new MockDisposable(),
    onDidChange: () => new MockDisposable(),
    onDidDelete: () => new MockDisposable(),
    dispose: () => {},
  }
}

export const window = {
  createOutputChannel: vi.fn((_name?: string, _options?: unknown) => vscodeMock.output),
  createStatusBarItem: vi.fn((_alignment?: number, _priority?: number) => statusBarItem),
  showInformationMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showWarningMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showErrorMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showInputBox: vi.fn(async (_options?: { validateInput?: (value: string) => string | undefined }) =>
    undefined as string | undefined),
  showQuickPick: vi.fn(async (_items?: unknown, _options?: unknown): Promise<unknown> =>
    undefined),
  withProgress: vi.fn(async (_options: unknown, task: (progress: unknown, token: unknown) => unknown) =>
    task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => new MockDisposable() })),
}

export const workspace = {
  getConfiguration: vi.fn((section: string) => ({
    get<T>(key: string, fallback?: T): T {
      const value = settings.get(`${section}.${key}`)
      return (value === undefined ? fallback : value) as T
    },
    async update(key: string, value: unknown): Promise<void> {
      settings.set(`${section}.${key}`, value)
    },
  })),
  createFileSystemWatcher: vi.fn((_pattern: unknown) => createWatcher()),
  fs: {
    stat: vi.fn(async (_uri: Uri) => ({ size: 0 })),
    readFile: vi.fn(async (_uri: Uri) => new Uint8Array()),
  },
}

export const env = {
  openExternal: vi.fn(async (_uri: Uri) => true),
}

export const extensions = {
  getExtension: vi.fn(),
}

export const commands = {
  registerCommand: vi.fn((command: string, handler: (...args: unknown[]) => unknown) => {
    commandHandlers.set(command, handler)
    return new MockDisposable(() => commandHandlers.delete(command))
  }),
  executeCommand: vi.fn(async (command: string, ...args: unknown[]) => {
    return await commandHandlers.get(command)?.(...args)
  }),
}

export const lm = {
  registerLanguageModelChatProvider: vi.fn((vendor: string, provider: unknown) => {
    vscodeMock.registeredProviders.push({ vendor, provider })
    return new MockDisposable()
  }),
}

export function resetVSCodeMock(): void {
  settings.clear()
  secrets.clear()
  commandHandlers.clear()
  vscodeMock.registeredProviders.length = 0
  vscodeMock.output.appendLine.mockReset()
  vscodeMock.output.show.mockReset()
  vscodeMock.output.dispose.mockReset()
  for (const value of Object.values(window))
    value.mockReset()
  window.createOutputChannel.mockReturnValue(vscodeMock.output)
  window.createStatusBarItem.mockReturnValue(statusBarItem)
  window.withProgress.mockImplementation(async (_options, task) =>
    task({ report: vi.fn() }, { isCancellationRequested: false, onCancellationRequested: () => new MockDisposable() }))
  statusBarItem.text = ''
  statusBarItem.tooltip = ''
  statusBarItem.command = undefined
  statusBarItem.show.mockClear()
  statusBarItem.hide.mockClear()
  statusBarItem.dispose.mockClear()
  for (const value of Object.values(workspace)) {
    if ('mockClear' in value) {
      value.mockClear()
    }
  }
  workspace.fs.stat.mockReset()
  workspace.fs.readFile.mockReset()
  workspace.fs.stat.mockResolvedValue({ size: 0 })
  workspace.fs.readFile.mockResolvedValue(new Uint8Array())
  env.openExternal.mockReset()
  env.openExternal.mockResolvedValue(true)
  extensions.getExtension.mockReset()
  for (const value of Object.values(commands))
    value.mockClear()
  lm.registerLanguageModelChatProvider.mockClear()
}
