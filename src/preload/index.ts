import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('mail', {
  call: (method: string, args: unknown[]) => ipcRenderer.invoke('api', method, args),
  on: (event: string, cb: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => cb(payload)
    ipcRenderer.on(`core:${event}`, listener)
    return () => ipcRenderer.removeListener(`core:${event}`, listener)
  },
  platform: process.platform,
})
