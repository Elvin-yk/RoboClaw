import { useEffect, useMemo, useRef, useState } from 'react'
import { api, postJson } from '@/shared/api/client'
import { useI18n } from '@/i18n'

interface LogEntry {
  line: string
  lineNumber: number
}

type LogGroup =
  | { kind: 'error'; entry: LogEntry }
  | { kind: 'normal'; entries: LogEntry[] }

interface LogSummary {
  groups: LogGroup[]
  errorCount: number
}

const ERROR_LOG_PATTERN = /traceback|exception|error|failed|failure|fatal|critical/i

export default function LogView() {
  const { t } = useI18n()
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const logRef = useRef<HTMLDivElement>(null)
  const logSummary = useMemo(() => buildLogSummary(logs), [logs])
  const errorCount = logSummary.errorCount
  const foldedCount = logs.length - errorCount

  useEffect(() => {
    let active = true

    const fetchLogs = async () => {
      try {
        const data = await api('/api/session/logs')
        if (!active) return
        setLogs(Array.isArray(data.lines) ? data.lines : [])
      } catch {
        if (!active) return
      } finally {
        if (active) setLoading(false)
      }
    }

    fetchLogs()
    const timer = window.setInterval(fetchLogs, 1000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight)
  }, [logs])

  const clearLogs = async () => {
    try {
      await postJson('/api/session/logs/clear')
      setLogs([])
    } catch { /* ignore */ }
  }

  return (
    <div className="page-enter flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 bg-sf border-b border-bd/50">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-bold tracking-tight">{t('logs')}</h2>
          {logs.length > 0 && (
            <div className="flex items-center gap-2 text-xs font-bold">
              <span className={`rounded-full px-2.5 py-1 ${errorCount > 0 ? 'bg-rd/10 text-rd' : 'bg-gn/10 text-gn'}`}>
                {errorCount} 个报错
              </span>
              <span className="rounded-full bg-bd/30 px-2.5 py-1 text-tx3">
                {foldedCount} 条已折叠
              </span>
            </div>
          )}
        </div>
        <button
          onClick={clearLogs}
          className="px-3 py-1.5 text-tx3 rounded-lg text-xs hover:text-tx2 hover:bg-bd/30 transition-colors"
        >
          {t('clear')}
        </button>
      </div>

      <div ref={logRef} className="flex-1 overflow-y-auto bg-bg px-6 py-4 font-mono text-sm">
        {!loading && logs.length === 0 && (
          <div className="text-tx3 text-center py-12 text-sm">{t('noLogs') || 'No logs yet'}</div>
        )}
        {loading && (
          <div className="text-tx3 text-center py-12 text-sm">Loading logs...</div>
        )}
        <div className="space-y-2">
          {logSummary.groups.map((group) => (
            group.kind === 'error'
              ? <ErrorLogLine key={`error-${group.entry.lineNumber}-${group.entry.line.slice(0, 24)}`} entry={group.entry} />
              : <NormalLogGroup key={`normal-${group.entries[0]?.lineNumber}`} entries={group.entries} />
          ))}
        </div>
      </div>
    </div>
  )
}

function isErrorLine(line: string): boolean {
  return ERROR_LOG_PATTERN.test(line)
}

function buildLogSummary(lines: string[]): LogSummary {
  const groups: LogGroup[] = []
  let normalEntries: LogEntry[] = []
  let errorCount = 0

  function flushNormalEntries(): void {
    if (normalEntries.length === 0) return
    groups.push({ kind: 'normal', entries: normalEntries })
    normalEntries = []
  }

  lines.forEach((line, index) => {
    const entry = { line, lineNumber: index + 1 }
    if (!isErrorLine(line)) {
      normalEntries.push(entry)
      return
    }
    errorCount += 1
    flushNormalEntries()
    groups.push({ kind: 'error', entry })
  })
  flushNormalEntries()
  return { groups, errorCount }
}

function ErrorLogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="rounded-lg border border-rd/30 bg-rd/10 px-3 py-2 text-rd shadow-sm">
      <div className="mb-1 flex items-center justify-between gap-3 text-xs font-bold">
        <span className="rounded bg-rd px-2 py-0.5 text-white">ERROR</span>
        <span className="text-rd/70">{String(entry.lineNumber).padStart(4, '0')}</span>
      </div>
      <div className="whitespace-pre-wrap break-words leading-6">{entry.line}</div>
    </div>
  )
}

function NormalLogGroup({ entries }: { entries: LogEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const first = entries[0]
  const last = entries[entries.length - 1]
  const preview = last?.line || ''
  return (
    <details
      className="rounded-lg border border-bd/50 bg-white/70"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-center gap-3 px-3 py-2 text-xs font-bold text-tx2">
        <span>非报错日志 {entries.length} 条</span>
        <span className="text-tx3">
          {String(first.lineNumber).padStart(4, '0')}-{String(last.lineNumber).padStart(4, '0')}
        </span>
        <span className="min-w-0 flex-1 truncate text-tx3">{preview}</span>
        <span className="text-ac">展开</span>
      </summary>
      {expanded && (
        <div className="border-t border-bd/40 px-3 py-2">
          {entries.map((entry) => (
            <div key={`${entry.lineNumber}-${entry.line.slice(0, 24)}`} className="py-1 text-tx3">
              <span className="mr-3 text-xs text-tx3/50">{String(entry.lineNumber).padStart(4, '0')}</span>
              <span className="whitespace-pre-wrap break-words">{entry.line}</span>
            </div>
          ))}
        </div>
      )}
    </details>
  )
}
