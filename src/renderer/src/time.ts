const at = (d: Date, h: number, m = 0) => {
  const x = new Date(d)
  x.setHours(h, m, 0, 0)
  return x
}
const addDays = (d: Date, n: number) => {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

export interface Preset {
  key: string
  label: string
  at: number
}

/** Snooze and send-later choices, relative to `now`. */
export function presets(now = new Date()): Preset[] {
  const list: Preset[] = []
  const laterToday = new Date(now.getTime() + 3 * 3_600_000)
  if (laterToday.getDate() === now.getDate()) list.push({ key: '1', label: 'Later today', at: laterToday.getTime() })
  if (now.getHours() < 17) list.push({ key: '2', label: 'This evening', at: at(now, 18).getTime() })
  list.push({ key: '3', label: 'Tomorrow', at: at(addDays(now, 1), 8).getTime() })
  const toSat = (6 - now.getDay() + 7) % 7 || 7
  list.push({ key: '4', label: 'This weekend', at: at(addDays(now, toSat), 9).getTime() })
  const toMon = (1 - now.getDay() + 7) % 7 || 7
  list.push({ key: '5', label: 'Next week', at: at(addDays(now, toMon), 8).getTime() })
  list.push({ key: '6', label: 'In a month', at: at(addDays(now, 30), 8).getTime() })
  return list.map((p, i) => ({ ...p, key: String(i + 1) }))
}

export function formatWhen(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const today = new Date(now)
  const sameDay = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (sameDay) return time
  const diff = Math.abs(ms - now)
  if (diff < 6 * 86_400_000) return `${d.toLocaleDateString([], { weekday: 'short' })} ${ms > now ? time : ''}`.trim()
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' })
}

export function formatFull(ms: number): string {
  return new Date(ms).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
