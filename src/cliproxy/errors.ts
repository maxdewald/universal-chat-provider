export class ProxyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
  }
}

export interface ProxyStreamErrorDetails {
  errorType?: string
  code?: string
  param?: string
  responseId?: string
  responseStatus?: string
}

export class ProxyStreamError extends Error {
  constructor(
    message: string,
    readonly details: ProxyStreamErrorDetails = {},
  ) {
    super(message)
  }
}
