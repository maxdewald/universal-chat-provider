import { beforeEach, describe, expect, it } from 'vitest'
import { StatusBarAlignment } from 'vscode'
import { createStatusBar, updateStatusBar } from '../../src/extension/status-bar'
import { resetVSCodeMock, statusBarItem, window } from '../support/vscode'

beforeEach(() => {
  resetVSCodeMock()
})

describe('status bar', () => {
  it('creates a manage-provider status item', () => {
    const item = createStatusBar()

    expect(window.createStatusBarItem).toHaveBeenCalledWith(StatusBarAlignment.Right, 100)
    expect(item.command).toBe('universalChatProvider.manage')
  })

  it.each([
    ['external', '$(server) Universal Chat Provider', 'using an external server'],
    ['starting', '$(loading~spin) Universal Chat Provider', 'starting the managed server'],
    ['running', '$(server-process) Universal Chat Provider', 'managed server running'],
    ['error', '$(error) Universal Chat Provider', 'managed server failed to start'],
  ] as const)('shows %s status', (status, text, tooltip) => {
    updateStatusBar(statusBarItem as never, status)

    expect(statusBarItem.text).toBe(text)
    expect(statusBarItem.tooltip).toContain(tooltip)
  })
})
