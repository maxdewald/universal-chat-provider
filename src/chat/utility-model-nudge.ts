import type { ExtensionContext } from 'vscode'
import type { UniversalChatProvider } from './provider'
import { commands, ConfigurationTarget, extensions, window, workspace } from 'vscode'

const SHOWN_KEY = 'universalChatProvider.utilityModelNudgeShown'
const SET_COMMAND = 'universalChatProvider.setUtilityModel'
const UCP_PREFIX = 'universal-chat-provider/'

/**
 * Decide whether to surface the one-time utility-model nudge. Kept pure so the
 * branching is testable without a vscode mock.
 *
 * `chat.utilityModel` / `chat.utilitySmallModel` only take effect inside the
 * Copilot extension's BYOK flows, so only nudge when Copilot is installed.
 * Without an override, Copilot runs its background tasks (commit messages, chat
 * titles, summaries) on its own models even when you chat through our provider
 * — pointing the override at one of our models routes them here instead. Skip
 * if it's already set to one of our models.
 */
export function shouldNudge(opts: {
  alreadyShown: boolean
  utilityModel: string
  copilotInstalled: boolean
}): boolean {
  return !opts.alreadyShown
    && opts.copilotInstalled
    && !opts.utilityModel.trim().startsWith(UCP_PREFIX)
}

export async function maybeSuggestUtilityModel(context: ExtensionContext): Promise<void> {
  const should = shouldNudge({
    alreadyShown: context.globalState.get<boolean>(SHOWN_KEY, false),
    utilityModel: workspace.getConfiguration('chat').get<string>('utilityModel', ''),
    copilotInstalled: extensions.getExtension('GitHub.copilot-chat') !== undefined,
  })
  if (!should)
    return

  // Show at most once, ever — set the flag up front so a missed notification
  // doesn't re-nag every launch (it stays in the notification center anyway).
  await context.globalState.update(SHOWN_KEY, true)

  const choose = 'Choose Model'
  const choice = await window.showInformationMessage(
    'Copilot generates commit messages, chat titles and summaries with its own models. '
    + 'Use one of your Universal Chat Provider models for those instead?',
    choose,
  )
  if (choice === choose)
    await commands.executeCommand(SET_COMMAND)
}

/**
 * Point `chat.utilityModel` and `chat.utilitySmallModel` at one of our models,
 * so Copilot's background flows (commit messages, chat titles, summaries) run
 * through this provider instead of Copilot's own models.
 */
export async function setUtilityModel(provider: UniversalChatProvider): Promise<void> {
  const models = await provider.getModels(true)
  if (models.length === 0) {
    void window.showWarningMessage(
      'No Universal Chat Provider models are available. Configure the provider and refresh its models first.',
    )
    return
  }

  const chat = workspace.getConfiguration('chat')
  const current = chat.get<string>('utilityModel', '').trim()
  const selected = await window.showQuickPick(
    models.map(model => ({
      label: model.name,
      description: UCP_PREFIX + model.id,
      picked: current === UCP_PREFIX + model.id,
      model,
      ...(model.detail !== undefined ? { detail: model.detail } : {}),
    })),
    {
      title: 'Set Utility Model',
      placeHolder: 'Model Copilot uses for commit messages, chat titles and summaries (clear to undo)',
      matchOnDescription: true,
    },
  )
  if (selected === undefined)
    return

  // utilitySmallModel drives the fast flows (commit messages, intent detection);
  // utilityModel drives the rest. Set both so everything routes through us.
  const value = UCP_PREFIX + selected.model.id
  await chat.update('utilityModel', value, ConfigurationTarget.Global)
  await chat.update('utilitySmallModel', value, ConfigurationTarget.Global)
  void window.showInformationMessage(
    `Copilot's commit messages, chat titles and summaries now use ${selected.model.name}.`,
  )
}
