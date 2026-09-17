/** The only module that knows OpenCode's DOM. Serialized into the proxy script. */
export function createOpenCodeAdapter() {
  const selector = '[data-component="prompt-input"][contenteditable="true"]'
  const editor = () =>
    Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
      (el) => el.getClientRects().length
    )
  // New-session drafts share pathname and differ by draftId in the query.
  const route = () => location.pathname + (location.search || '')
  const sendButton = (input: HTMLElement) => {
    const form = input.closest('form')
    return (
      form?.querySelector<HTMLButtonElement>(
        'button[data-action="prompt-submit"]'
      ) ?? form?.querySelector<HTMLButtonElement>('button[type="submit"]')
    )
  }
  function mount(button: HTMLButtonElement, settings: HTMLButtonElement) {
    const input = editor()
    const send = input && sendButton(input)
    if (!send?.parentElement) {
      button.remove()
      settings.remove()
      return
    }
    if (
      button.parentElement !== send.parentElement ||
      button.nextElementSibling !== send
    )
      send.parentElement.insertBefore(button, send)
    if (
      settings.parentElement !== send.parentElement ||
      settings.nextElementSibling !== button
    )
      send.parentElement.insertBefore(settings, button)
  }
  function insert(text: string, expectedRoute: string): HTMLElement {
    if (route() !== expectedRoute)
      throw new Error(
        'Вернитесь в исходную сессию для вставки или скопируйте текст.'
      )
    const input = editor()
    if (!input || !text.trim())
      throw new Error(
        'Поле ввода недоступно или текст пуст. Результат сохранён.'
      )
    input.focus()
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    selection?.removeAllRanges()
    selection?.addRange(range)
    // Native editing invokes Solid's onInput, preserving existing mentions and attachments.
    if (
      !document.execCommand(
        'insertText',
        false,
        (input.textContent ? ' ' : '') + text
      )
    ) {
      throw new Error('Не удалось вставить текст. Скопируйте его ниже.')
    }
    return input
  }
  async function submit(
    input: HTMLElement,
    expectedRoute: string,
    signal?: AbortSignal
  ) {
    // Give the framework a frame to update its send state; never queue a later submit.
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    if (signal?.aborted)
      throw new Error('Текст вставлен. Автоматическая отправка отменена.')
    if (route() !== expectedRoute || editor() !== input || !input.isConnected)
      throw new Error(
        'Сессия изменилась. Текст вставлен в исходный черновик, автоматическая отправка отменена.'
      )
    const send = sendButton(input)
    if (
      !send ||
      send.disabled ||
      send.getAttribute('aria-disabled') === 'true' ||
      send.querySelector('[data-icon="stop"]')
    )
      throw new Error(
        'Текст вставлен. Нажмите Send, когда OpenCode будет готов.'
      )
    send.click()
  }
  return { editor, route, mount, insert, submit }
}
