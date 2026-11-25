export type Feed = {
  id: string
  agent: string // '' on the main loop, else the subagent's short label
  kind: string
  target: string
  source: string
  language: string
  startLine: number
  diffOld: number // 0 = not a diff; else the hunk's first old line
  diffNew: number
  startTick: number
  startedAt: number
  isDone: boolean
  summary: string
  isError: boolean
}
export type LogLine = {
  id: string
  agent: string
  at: string
  kind: string
  target: string
  note: string
  durMs: number
  isDone: boolean
  isError: boolean
}
export type Stats = { ops: number; added: number; removed: number; startedAt: number }
export type Usage = { input: number; cacheRead: number; cacheWrite: number; output: number; usd: number; hasUsd: boolean }
export type Narration = { text: string; isThinking: boolean; at: number }
export type Lane = {
  id: string
  label: string
  type: string
  status: string
  startTime: number
  tokens: number
  last: string
  isDone: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'hacker-view': {
      history: Shaped<Feed[]>
      selected: Shaped<string | null>
      log: Shaped<LogLine[]>
      stats: Shaped<Stats>
      usage: Shaped<Usage>
      narration: Shaped<Narration>
      lanes: Shaped<Lane[]>
      tick: number
      busy: number
    }
  }
}
