import type { Api, CoreEvents } from '../../shared/types'

declare global {
  interface Window {
    mail: {
      call(method: string, args: unknown[]): Promise<unknown>
      on(event: string, cb: (payload: unknown) => void): () => void
      platform: string
    }
  }
}

type Async<T> = { [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : never }

/** Calls into the mail core in the main process. Errors arrive with Electron's IPC prefix stripped. */
export const api = new Proxy({} as Async<Api>, {
  get: (_, method: string) => async (...args: unknown[]) => {
    try {
      return await window.mail.call(method, args)
    } catch (e) {
      throw new Error(String((e as Error).message).replace(/^Error invoking remote method 'api': (Error: )?/, ''))
    }
  },
})

export function onCore<K extends keyof CoreEvents>(event: K, cb: (payload: CoreEvents[K]) => void) {
  return window.mail.on(event, cb as (p: unknown) => void)
}

export const isMac = window.mail.platform === 'darwin'
export const mod = isMac ? '⌘' : 'Ctrl'
