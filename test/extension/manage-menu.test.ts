import type { QuickPickItem } from 'vscode'
import type { ServerController, ServerStatusSnapshot } from '../../src/cliproxy/controller'
import { beforeEach, describe, expect, it } from 'vitest'
import { manageProvider } from '../../src/extension/manage-menu'
import { commands, resetVSCodeMock, window } from '../support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('manageProvider', () => {
  it('shows managed server actions', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined)

    await manageProvider(controller('managed', { mode: 'managed', status: 'running', baseUrl: 'http://127.0.0.1:8317' }))

    const labels = quickPickLabels()
    expect(labels).toContain('$(debug-restart) Restart Server')
    expect(labels).toContain('$(cloud-download) Update Proxy Binary')
    expect(labels).not.toContain('$(settings-gear) Configure Connection')
  })

  it('shows external connection actions', async () => {
    window.showQuickPick.mockResolvedValueOnce(undefined)

    await manageProvider(controller('external', { mode: 'external', status: 'external', baseUrl: 'http://127.0.0.1:8317' }))

    const labels = quickPickLabels()
    expect(labels).toContain('$(settings-gear) Configure Connection')
    expect(labels).toContain('$(key) Import API Key from Config')
    expect(labels).not.toContain('$(debug-restart) Restart Server')
  })

  it.each([
    ['managed', { mode: 'managed', status: 'running', baseUrl: 'http://127.0.0.1:8317' }, 'universalChatProvider.showServerLogs'],
    ['external', { mode: 'external', status: 'external', baseUrl: 'http://127.0.0.1:8317' }, 'universalChatProvider.showLogs'],
  ] as const)('dispatches the %s status row', async (_mode, snapshot, command) => {
    window.showQuickPick.mockImplementationOnce(async items => (items as Array<QuickPickItem>)[0])

    await manageProvider(controller(snapshot.mode, snapshot))

    expect(commands.executeCommand).toHaveBeenCalledWith(command)
  })
})

function controller(mode: 'managed' | 'external', snapshot: ServerStatusSnapshot): ServerController {
  return {
    mode: () => mode,
    statusSnapshot: async () => snapshot,
  } as unknown as ServerController
}

function quickPickLabels(): string[] {
  return (window.showQuickPick.mock.calls[0]?.[0] as QuickPickItem[]).map(item => item.label)
}
