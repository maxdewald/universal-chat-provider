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
}

export class LanguageModelTextPart {
  constructor(readonly value: string) {}
}

export class LanguageModelThinkingPart {
  constructor(
    readonly value: string | string[],
    readonly id?: string,
    readonly metadata?: Readonly<Record<string, unknown>>,
  ) {}
}

export class LanguageModelDataPart {
  static image(data: Uint8Array, mimeType: string): LanguageModelDataPart {
    return new LanguageModelDataPart(data, mimeType)
  }

  static text(value: string, mimeType = 'text/plain'): LanguageModelDataPart {
    return new LanguageModelDataPart(new TextEncoder().encode(value), mimeType)
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

export const window = {
  createOutputChannel: vi.fn((_name?: string, _options?: unknown) => vscodeMock.output),
  showInformationMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showWarningMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showErrorMessage: vi.fn(async (_message?: string, ..._items: unknown[]) => undefined as string | undefined),
  showInputBox: vi.fn(async (_options?: { validateInput?: (value: string) => string | undefined }) =>
    undefined as string | undefined),
  showQuickPick: vi.fn(async (_items?: unknown, _options?: unknown) =>
    undefined as { command: string } | undefined),
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
  for (const value of Object.values(workspace))
    value.mockClear()
  for (const value of Object.values(commands))
    value.mockClear()
  lm.registerLanguageModelChatProvider.mockClear()
}
