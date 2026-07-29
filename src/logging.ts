export interface Logger {
  debug: (message: string) => void
  info: (message: string) => void
  warning: (message: string) => void
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warning: () => undefined
}
