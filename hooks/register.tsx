import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Feed, Lane, LogLine, Narration, Stats, Usage } from '../types'

const PANE = 'hacker-view'
const TITLE = 'Live session'

const history = atom({ plugin: 'hacker-view', key: 'history' } as const, [] as Feed[], { shape: 'history-1' })
const selected = atom({ plugin: 'hacker-view', key: 'selected' } as const, null as string | null, { shape: 'selected-1' })
const log = atom({ plugin: 'hacker-view', key: 'log' } as const, [] as LogLine[], { shape: 'log-3' })
const stats = atom(
  { plugin: 'hacker-view', key: 'stats' } as const,
  { ops: 0, added: 0, removed: 0, startedAt: Date.now() } as Stats,
  { shape: 'stats-2' },
)
const usage = atom(
  { plugin: 'hacker-view', key: 'usage' } as const,
  { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, usd: 0, hasUsd: false } as Usage,
  { shape: 'usage-1' },
)
const narration = atom(
  { plugin: 'hacker-view', key: 'narration' } as const,
  { text: '', isThinking: false, at: 0 } as Narration,
  { shape: 'narration-1' },
)
const lanes = atom({ plugin: 'hacker-view', key: 'lanes' } as const, [] as Lane[], { shape: 'lanes-1' })
const tick = atom({ plugin: 'hacker-view', key: 'tick' } as const, 0)
const busy = atom({ plugin: 'hacker-view', key: 'busy' } as const, 0)

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const KEEP_FEEDS = 30
const MAX_SOURCE = 12000
const CTX = 3 // context lines around a diff

const LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript', cjs: 'javascript', py: 'python',
  rs: 'rust', go: 'go', java: 'java', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c', lua: 'lua',
  json: 'json', md: 'markdown', html: 'html', css: 'css', sh: 'bash', ps1: 'powershell', psm1: 'powershell',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql', rb: 'ruby', php: 'php', kt: 'kotlin', swift: 'swift', xml: 'xml',
}

// Module-local (resets on reload, which is fine).
let lastActivity = 0
let idleFrames = 0
const agentLast = new Map<string, string>() // agentId -> last action
const agentDoneAt = new Map<string, number>()
let lanesJson = '[]'

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number => (typeof v === 'number' ? v : 0)
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : {}
const langOf = (p: string) => LANG[(p.split('.').pop() ?? '').toLowerCase()] ?? ''
const countLines = (s: string) => (s === '' ? 0 : s.split('\n').length)
const stamp = () => {
  const d = new Date()
  return `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
}
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length))
const fmtTok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`
const fmtMs = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m${Math.floor(ms / 1000) % 60}s` : ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`)
const tidy = (p: string) => p.replace(/^[A-Za-z]:[\\/]Users[\\/][^\\/]+/, '~').replace(/\\/g, '/')
const middle = (s: string, n: number) =>
  s.length <= n ? s : `${s.slice(0, Math.ceil(n / 2) - 1)}…${s.slice(s.length - Math.floor(n / 2))}`
const tail = (s: string, n: number) => s.split('\n').slice(-n).join('\n')
const head = (s: string, n: number) => s.split('\n').slice(0, n).join('\n')
const cap = (s: string) => (s.length > MAX_SOURCE ? `${s.slice(0, MAX_SOURCE)}\n… (${s.length - MAX_SOURCE} more chars)` : s)
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim()

/** A unified hunk header + body for the first `k` of `lines` (each starting ' ', '-' or '+'). */
const hunk = (oldStart: number, newStart: number, lines: string[]) => {
  let o = 0
  let n = 0
  for (const l of lines) {
    if (l[0] !== '+') o++
    if (l[0] !== '-') n++
  }
  return `@@ -${oldStart},${o} +${newStart},${n} @@\n${lines.join('\n')}`
}

type Plan = { target: string; source: string; language: string }

const plan = (tool: string, a: Record<string, unknown>): Plan => {
  const path = str(a.file_path) || str(a.notebook_path) || str(a.path)
  const p = { target: tidy(path), source: '', language: '' }
  switch (tool) {
    case 'Write':
      return { ...p, source: cap(str(a.content)), language: langOf(path) }
    case 'Edit':
      return p // filled in with a real diff before the edit runs
    case 'Bash':
      return { ...p, target: str(a.command), source: `$ ${str(a.command)}\n`, language: 'bash' }
    case 'PowerShell':
      return { ...p, target: str(a.command), source: `PS> ${str(a.command)}\n`, language: 'powershell' }
    case 'Grep':
      return { ...p, target: `/${str(a.pattern)}/ ${tidy(path) || '.'}` }
    case 'Glob':
      return { ...p, target: `${str(a.pattern)} ${tidy(path)}`.trim() }
    case 'WebFetch':
      return { ...p, target: str(a.url) }
    case 'WebSearch':
      return { ...p, target: str(a.query) }
    case 'Agent':
      return { ...p, target: str(a.description), source: cap(str(a.prompt)), language: 'markdown' }
    default:
      return { ...p, target: p.target || str(a.description) || str(a.query) || str(a.command) }
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hacker', description: 'Open the live session monitor pane' })
    void $.ui.open({ id: PANE, title: TITLE })

    let frame = 0
    $.clock.every(100, async () => {
      frame++
      const active = (await read($, busy)) > 0 || Date.now() - lastActivity < 6000
      idleFrames = active ? 0 : idleFrames + 1
      if (active || idleFrames % 10 === 0) await update($, tick, n => n + 1)

      // Background agents, once a second.
      if (frame % 10 !== 0) return
      try {
        const now = Date.now()
        const list = await $.agent.list()
        const out: Lane[] = []
        for (const ag of list) {
          const isDone = ag.status === 'completed' || ag.status === 'failed' || ag.status === 'killed' || ag.status === 'idle'
          if (isDone && !agentDoneAt.has(ag.id)) agentDoneAt.set(ag.id, now)
          if (isDone && now - (agentDoneAt.get(ag.id) ?? now) > 45000) continue
          out.push({
            id: ag.id,
            label: oneLine(ag.description || ag.label || ag.name || ag.type),
            type: ag.type,
            status: ag.status,
            startTime: ag.startTime,
            tokens: ag.tokenCount,
            last: agentLast.get(ag.id) ?? '',
            isDone,
          })
        }
        const json = JSON.stringify(out)
        if (json !== lanesJson) {
          lanesJson = json
          await update($, lanes, () => out)
        }
      } catch {
        // agent listing is best-effort
      }
    })

    return next(e)
  })

  on('command.run', { command: 'hacker' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Live session monitor opened.' }
  })

  // ── 1 + 5: narration and real token usage, from the model's own stream ──
  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    let buf = ''
    let hasText = false
    let lastFlush = 0
    const flush = (isThinking: boolean) => {
      lastFlush = Date.now()
      lastActivity = lastFlush
      void update($, narration, () => ({ text: buf.slice(-600), isThinking, at: lastFlush })).catch(() => {})
    }

    for await (const c of next(e)) {
      try {
        if (isMain && c.kind === 'text') {
          if (!hasText) { hasText = true; buf = '' }
          buf += c.text
          if (Date.now() - lastFlush > 90) flush(false)
        } else if (isMain && c.kind === 'thinking' && !hasText) {
          if (Date.now() - lastFlush > 500) {
            lastFlush = Date.now()
            void update($, narration, n => ({ ...n, isThinking: true, at: lastFlush })).catch(() => {})
          }
        } else if (c.kind === 'stop' && c.usage) {
          const u = c.usage
          void update($, usage, s => ({
            ...s,
            input: s.input + u.input_tokens,
            cacheRead: s.cacheRead + u.cache_read_input_tokens,
            cacheWrite: s.cacheWrite + u.cache_creation_input_tokens,
            output: s.output + u.output_tokens,
          })).catch(() => {})
        }
      } catch {
        // the monitor never disturbs the stream
      }
      yield c
    }
    if (isMain && hasText) flush(false)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    try {
      const s = await $.session.usage()
      if (s.cost) await update($, usage, u => ({ ...u, usd: s.cost?.usd ?? u.usd, hasUsd: true }))
    } catch {
      // cost is optional
    }
    return r
  })

  // ── tool calls: live window, replay history, real diffs, agent lanes ──
  on('tool.call', async ($, e, next) => {
    const a = e as unknown as Record<string, unknown>
    const tool = e.tool
    const id = e.tool_use_id ?? `${tool}-${Date.now()}`
    const agentId = e.agentId ?? ''
    const p = plan(tool, a)
    const t = await read($, tick)
    const startedAt = Date.now()
    lastActivity = startedAt
    if (agentId) agentLast.set(agentId, `${tool} ${middle(oneLine(p.target), 50)}`)

    // 3: a real diff, located in the file before the edit runs.
    let diffOld = 0
    let diffNew = 0
    let source = p.source
    let language = p.language
    if (tool === 'Edit') {
      const oldS = str(a.old_string).replace(/\r\n/g, '\n')
      const newS = str(a.new_string).replace(/\r\n/g, '\n')
      let before: string[] = []
      let after: string[] = []
      let at = 1
      try {
        const text = (await $.fs.read(str(a.file_path))).replace(/\r\n/g, '\n')
        const idx = text.indexOf(oldS)
        if (idx >= 0) {
          const pre = text.slice(0, idx)
          at = pre.split('\n').length
          const allLines = text.split('\n')
          const oldCount = oldS.split('\n').length
          // context: whole lines around the match
          const firstLine = at - 1
          const lastLine = firstLine + oldCount - 1
          const preFrag = allLines[firstLine]?.slice(0, idx - pre.lastIndexOf('\n') - 1) ?? ''
          const postFrag = (allLines[lastLine] ?? '').slice((lastLine === firstLine ? preFrag.length : 0) + (oldS.split('\n').pop() ?? '').length)
          before = allLines.slice(Math.max(0, firstLine - CTX), firstLine)
          after = allLines.slice(lastLine + 1, lastLine + 1 + CTX)
          const oldLines = oldS.split('\n')
          const newLines = newS.split('\n')
          oldLines[0] = preFrag + oldLines[0]
          newLines[0] = preFrag + newLines[0]
          oldLines[oldLines.length - 1] += postFrag
          newLines[newLines.length - 1] += postFrag
          const body = [
            ...before.map(l => ` ${l}`),
            ...oldLines.map(l => `-${l}`),
            ...newLines.map(l => `+${l}`),
            ...after.map(l => ` ${l}`),
          ]
          diffOld = Math.max(1, at - before.length)
          diffNew = diffOld
          source = cap(body.join('\n'))
        }
      } catch {
        // unreadable file: fall through to a plain -/+ block
      }
      if (diffOld === 0) {
        diffOld = 1
        diffNew = 1
        source = cap([...oldS.split('\n').map(l => `-${l}`), ...newS.split('\n').map(l => `+${l}`)].join('\n'))
      }
      language = 'diff'
    }

    const entry: Feed = {
      id, agent: agentId, kind: tool, target: p.target, source, language, startLine: 1,
      diffOld, diffNew, startTick: t, startedAt, isDone: false, summary: '', isError: false,
    }
    await update($, busy, n => n + 1)
    await update($, history, h => [...h.filter(x => x.id !== id), entry].slice(-KEEP_FEEDS))
    await update($, log, l => [...l, { id, agent: agentId, at: stamp(), kind: tool, target: p.target, note: '', durMs: 0, isDone: false, isError: false }].slice(-120))

    let ran
    try {
      ran = await next(e)
    } finally {
      await update($, busy, n => Math.max(0, n - 1))
      lastActivity = Date.now()
    }

    const durMs = Date.now() - startedAt
    const res = obj(ran?.result)
    const isError = ran?.deny !== undefined || ran?.isError === true
    let note = ''
    let summary = ''
    let extra = ''
    let startLine = 1
    let added = 0
    let removed = 0

    switch (tool) {
      case 'Write':
        added = countLines(str(a.content))
        note = `+${added}`
        summary = `wrote ${added} lines to ${p.target}`
        break
      case 'Edit':
        added = countLines(str(a.new_string))
        removed = countLines(str(a.old_string))
        note = `+${added} −${removed}`
        summary = `patched ${p.target} at line ${diffOld + Math.min(CTX, diffOld - 1)}`
        break
      case 'Bash':
      case 'PowerShell': {
        const out = (str(res.stdout) + (str(res.stderr) ? `\n${str(res.stderr)}` : '')).trimEnd()
        extra = tail(out, 60)
        note = isError ? 'exit ≠ 0' : 'exit 0'
        summary = `${note} · ${countLines(out)} lines of output`
        break
      }
      case 'Read': {
        const f = obj(res.file)
        const content = str(f.content)
        if (content) {
          extra = head(content, 150)
          startLine = num(f.startLine) || 1
          const end = startLine + num(f.numLines) - 1
          note = `L${startLine}-${end}/${num(f.totalLines)}`
          summary = `read ${num(f.numLines)} of ${num(f.totalLines)} lines`
        } else {
          note = 'binary'
          summary = 'read binary file'
        }
        break
      }
      case 'Grep': {
        const files = Array.isArray(res.filenames) ? (res.filenames as unknown[]).map(x => tidy(str(x))) : []
        extra = str(res.content) ? head(str(res.content), 80) : files.slice(0, 60).join('\n')
        note = `${num(res.numMatches) || num(res.numFiles)} hits`
        summary = `${num(res.numFiles)} files matched`
        break
      }
      case 'Glob': {
        const files = Array.isArray(res.filenames) ? (res.filenames as unknown[]).map(x => tidy(str(x))) : []
        extra = files.slice(0, 60).join('\n')
        note = `${num(res.numFiles)} files`
        summary = `${num(res.numFiles)} paths`
        break
      }
      default:
        note = isError ? 'error' : 'ok'
        summary = isError ? 'failed' : 'done'
    }
    if (isError) {
      const why = ran?.deny ?? (typeof ran?.text === 'string' ? ran.text : '')
      if (why && !extra) extra = head(why, 20)
      summary = `error · ${summary}`
    }

    const t2 = await read($, tick)
    await update($, history, h =>
      h.map(f => {
        if (f.id !== id) return f
        const done = { ...f, isDone: true, summary, isError }
        if (tool === 'Bash' || tool === 'PowerShell') return { ...done, source: cap(`${f.source}${extra}\n`) }
        if (tool === 'Read' && extra) return { ...done, source: cap(extra), language: langOf(str(a.file_path)), startLine, startTick: t2 }
        if ((tool === 'Grep' || tool === 'Glob') && extra) return { ...done, source: cap(extra), language: '', startTick: t2 }
        if (!f.source && extra) return { ...done, source: cap(extra), startTick: t2 }
        return done
      }),
    )
    await update($, stats, s => ({ ...s, ops: s.ops + 1, added: s.added + added, removed: s.removed + removed }))
    await update($, log, l => l.map(x => (x.id === id ? { ...x, note, durMs, isDone: true, isError } : x)))

    return ran
  }).catch(($, e, next) => next(e)) // a viewer must never block a tool

  // ── drawing ──
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Code, Button } = $.ui.resolve(e)
    const t = await read($, tick)
    const hist = await read($, history)
    const sel = await read($, selected)
    const lg = await read($, log)
    const s = await read($, stats)
    const u = await read($, usage)
    const nar = await read($, narration)
    const ln = await read($, lanes)
    const working = (await read($, busy)) > 0
    const rows = e.viewport?.rows ?? 40
    const cols = Math.max(40, Math.min(140, (e.viewport?.columns ?? 80) - 4))
    const spin = SPIN[t % SPIN.length] ?? '·'

    const up = Math.floor((Date.now() - s.startedAt) / 1000)
    const uptime = `${String(Math.floor(up / 3600)).padStart(2, '0')}:${String(Math.floor(up / 60) % 60).padStart(2, '0')}:${String(up % 60).padStart(2, '0')}`

    const picked = sel ? hist.find(f => f.id === sel) : undefined
    const isReplay = picked !== undefined
    const mainFeeds = hist.filter(f => f.agent === '')
    const f = picked ?? mainFeeds[mainFeeds.length - 1] ?? hist[hist.length - 1] ?? null

    // narration
    const narAge = Date.now() - nar.at
    const narText = nar.text ? oneLine(nar.text) : ''
    const narShown = narText.length > cols * 2 ? `…${narText.slice(-(cols * 2 - 1))}` : narText

    // window content (typewriter on the live view; replay shows it whole)
    const activeLanes = ln.length
    const logRoom = Math.max(5, Math.min(14, Math.floor(rows * 0.3)))
    const codeRoom = Math.max(8, rows - logRoom - 14 - activeLanes - (narShown ? 2 : 0))
    let view = ''
    let typing = false
    let lineNo: number | undefined
    let isDiff = false
    if (f && f.source) {
      if (f.diffOld > 0) {
        isDiff = true
        const all = f.source.split('\n')
        const step = Math.max(1, Math.ceil(all.length / 30))
        const k = isReplay ? all.length : Math.min(all.length, Math.max(1, (t - f.startTick) * step))
        typing = k < all.length
        const shownLines = all.slice(0, k)
        // keep the window to the room: drop leading lines but keep hunk numbers right
        const drop = Math.max(0, shownLines.length - codeRoom)
        let oldStart = f.diffOld
        let newStart = f.diffNew
        for (const l of shownLines.slice(0, drop)) {
          if (l[0] !== '+') oldStart++
          if (l[0] !== '-') newStart++
        }
        view = hunk(oldStart, newStart, shownLines.slice(drop))
      } else {
        const stepChars = Math.max(24, Math.ceil(f.source.length / 40))
        const n = isReplay ? f.source.length : (t - f.startTick) * stepChars
        typing = n < f.source.length
        const shown = typing ? f.source.slice(0, Math.max(0, n)) : f.source
        const all = shown.split('\n')
        const from = Math.max(0, all.length - codeRoom)
        view = all.slice(from).join('\n') + (typing || !f.isDone ? '▌' : '')
        lineNo = f.language === 'bash' || f.language === 'powershell' || f.language === 'markdown' ? undefined : (f.startLine || 1) + from
      }
    }

    const shell = f && (f.kind === 'Bash' || f.kind === 'PowerShell')
    const winTitle = f ? `${f.kind.toLowerCase()} — ${middle(f.target || '', Math.max(20, cols - f.kind.length - 34))}` : 'idle'
    const targetW = Math.max(16, cols - 46)
    const totalIn = u.input + u.cacheRead + u.cacheWrite

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* status line */}
        <Text mono>
          <Text color="claude" weight="bold">claude</Text>
          <Text color="subtle">@session  </Text>
          <Text color={working ? 'warning' : 'success'}>{working ? `${spin} busy` : '● idle'}</Text>
          <Text color="subtle">  ops </Text><Text>{s.ops}</Text>
          <Text color="subtle">  diff </Text><Text color="diffAdded">+{s.added}</Text><Text color="subtle">/</Text><Text color="diffRemoved">−{s.removed}</Text>
          <Text color="subtle">  up </Text><Text>{uptime}</Text>
        </Text>
        <Text mono>
          <Text color="subtle">tokens  in </Text><Text>{fmtTok(u.input)}</Text>
          <Text color="subtle">  cache-read </Text><Text>{fmtTok(u.cacheRead)}</Text>
          <Text color="subtle">  cache-write </Text><Text>{fmtTok(u.cacheWrite)}</Text>
          <Text color="subtle">  out </Text><Text>{fmtTok(u.output)}</Text>
          <Text color="subtle">  total </Text><Text weight="bold">{fmtTok(totalIn + u.output)}</Text>
          {u.hasUsd ? <Text color="subtle">  ≈ ${u.usd.toFixed(2)} est.</Text> : null}
        </Text>

        {/* 1: what Claude is saying right now */}
        {narShown || (nar.isThinking && narAge < 8000) ? (
          <Box marginTop={1}>
            <Text color="claude">› </Text>
            {narShown && !(nar.isThinking && narAge < 3000 && !working) ? (
              <Text italic color={narAge < 4000 ? 'text' : 'subtle'}>{narShown}</Text>
            ) : (
              <Text color="subtle" italic>thinking {spin}</Text>
            )}
          </Box>
        ) : null}

        {/* 4: background agents */}
        {ln.length > 0 ? (
          <Box flexDirection="column" marginTop={1}>
            {ln.map(l => (
              <Text mono>
                <Text color={l.isDone ? (l.status === 'completed' || l.status === 'idle' ? 'success' : 'error') : 'warning'}>
                  {l.isDone ? (l.status === 'completed' || l.status === 'idle' ? '✓' : '✗') : spin}
                </Text>
                <Text color="suggestion"> {pad(middle(l.label, 26), 26)}</Text>
                <Text color="subtle"> {pad(l.type, 14)} </Text>
                <Text>{pad(middle(l.last || l.status, Math.max(10, cols - 72)), Math.max(10, cols - 72))}</Text>
                <Text color="subtle"> {pad(fmtTok(l.tokens), 7)} {fmtMs(Date.now() - l.startTime)}</Text>
              </Text>
            ))}
          </Box>
        ) : null}

        {/* 2 + 3: the window */}
        <Box flexDirection="column" borderStyle="round" borderColor={isReplay ? 'suggestion' : shell ? 'bashBorder' : f && !f.isDone ? 'claude' : 'subtle'} paddingX={1} marginTop={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text mono>
              <Text color={f && !f.isDone ? 'warning' : f?.isError ? 'error' : 'success'}>{f && !f.isDone ? spin : f?.isError ? '✗' : '✓'} </Text>
              {isReplay ? <Text color="suggestion">replay · </Text> : null}
              {f && f.agent ? <Text color="suggestion">agent · </Text> : null}
              <Text weight="bold">{winTitle}</Text>
              {f && !f.isDone ? <Text color="subtle">  {fmtMs(Date.now() - f.startedAt)}</Text> : null}
            </Text>
            {isReplay ? (
              <Button key="back-live" plain onPress={() => update($, selected, () => null)}>
                <Text color="suggestion">● back to live</Text>
              </Button>
            ) : null}
          </Box>
          {f && f.source ? (
            isDiff ? (
              <Code source={view} format="diff" path={f.target} />
            ) : (
              <Code source={view} language={f.language || undefined} startLine={lineNo} />
            )
          ) : (
            <Text color="subtle" mono>{f ? (f.isDone ? '(no output)' : 'waiting for output…') : 'no activity yet — start a task and it streams here'}</Text>
          )}
          {f && f.isDone && f.summary ? <Text color={f.isError ? 'error' : 'subtle'} mono>── {f.summary}{typing ? '' : ''}</Text> : null}
        </Box>

        {/* 2: clickable log */}
        <Text color="subtle" mono>{`TIME          OP          ${pad('TARGET', targetW)} RESULT        TOOK   (click a row to replay)`}</Text>
        {lg.length === 0 && <Text color="subtle" mono>—</Text>}
        {lg.slice(-logRoom).map(l => {
          const isSel = sel === l.id
          const canReplay = hist.some(h => h.id === l.id)
          const row = (
            <Text mono>
              <Text color={isSel ? 'suggestion' : 'subtle'}>{isSel ? '› ' : '  '}{l.at}  </Text>
              <Text color={l.isError ? 'error' : l.isDone ? 'suggestion' : 'warning'}>{pad(`${l.agent ? '↳' : ''}${l.kind}`, 11)}</Text>
              <Text weight={isSel ? 'bold' : undefined}> {pad(middle(oneLine(l.target), targetW), targetW)} </Text>
              <Text color={l.isError ? 'error' : 'subtle'}>{pad(l.isDone ? l.note : `${spin} running`, 13)} </Text>
              <Text color="subtle">{l.isDone ? fmtMs(l.durMs) : ''}</Text>
            </Text>
          )
          return canReplay ? (
            <Button key={`row-${l.id}`} plain onPress={() => update($, selected, cur => (cur === l.id ? null : l.id))}>
              {row}
            </Button>
          ) : (
            row
          )
        })}
      </Box>
    )
  })
}
