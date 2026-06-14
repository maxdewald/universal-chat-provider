export interface ServerSentEvent {
  event?: string
  data: string
}

export async function* parseServerSentEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<ServerSentEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done)
        break
      buffer += decoder.decode(value, { stream: true })
      buffer = buffer.replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary >= 0) {
        const block = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseBlock(block)
        if (event)
          yield event
        boundary = buffer.indexOf('\n\n')
      }
    }

    buffer = (buffer + decoder.decode()).replace(/\r\n?/g, '\n')
    const event = parseBlock(buffer)
    if (event)
      yield event
  }
  finally {
    reader.releaseLock()
  }
}

function parseBlock(block: string): ServerSentEvent | undefined {
  let event: string | undefined
  const data: string[] = []

  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':'))
      continue
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
    if (field === 'event')
      event = value
    else if (field === 'data')
      data.push(value)
  }

  if (data.length === 0)
    return undefined
  return {
    ...(event === undefined ? {} : { event }),
    data: data.join('\n'),
  }
}
