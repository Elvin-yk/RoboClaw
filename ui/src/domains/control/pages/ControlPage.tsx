import { useEffect, useMemo, useState } from 'react'
import { collectionApi, type Assignment, type CollectionStatus } from '@/domains/collection/api/collectionApi'
import { assignmentProgressPct, formatHours, todayIso } from '@/domains/collection/lib/metrics'
import { useHardwareStore, type HardwareStatus, type OperationCapability } from '@/domains/hardware/store/useHardwareStore'
import { useSessionStore, type SessionState, type SessionStatus } from '@/domains/session/store/useSessionStore'
import { useI18n } from '@/i18n'
import { ActionButton } from '@/shared/ui'

const COLLECTION_REFRESH_MS = 5000
const TODAY_REFRESH_MS = 60000
const blockedCapability: OperationCapability = { ready: false, missing: [] }

function ActionBtn({
  children, disabled, onClick, color, title,
}: {
  children: React.ReactNode
  disabled?: boolean
  onClick?: () => void
  color: 'ac' | 'gn' | 'rd' | 'yl'
  title?: string
}) {
  const cls: Record<string, string> = {
    ac: 'bg-ac hover:bg-ac2 shadow-glow-ac',
    gn: 'bg-gn hover:bg-gn/90 shadow-glow-gn',
    rd: 'bg-rd hover:bg-rd/90 shadow-glow-rd',
    yl: 'bg-yl hover:bg-yl/90 shadow-glow-yl',
  }
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition-all
        active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-25 disabled:shadow-none ${cls[color]}`}
    >
      {children}
    </button>
  )
}

function capabilityReason(capability: OperationCapability) {
  return capability.missing.join(' · ')
}

function capabilityOf(hwStatus: any, name: string): OperationCapability {
  return hwStatus?.capabilities?.[name] ?? blockedCapability
}

function canStart(state: SessionState) {
  return state === 'idle'
}

function formatSeconds(seconds: number) {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`
}

function sessionHasError(session: SessionStatus, collectionStatus: CollectionStatus | null) {
  return session.state === 'error'
    || Boolean(session.error)
    || collectionStatus?.session.state === 'error'
    || Boolean(collectionStatus?.session.error)
}

function sessionErrorText(session: SessionStatus, collectionStatus: CollectionStatus | null) {
  return session.error || collectionStatus?.session.error || '本地 session 处于 error 状态'
}

function DeviceDots({ label, dots }: {
  label: string
  dots: Array<{ key: string; className: string; title: string }>
}) {
  return (
    <div className="control-device-row">
      <div className="control-device-label">{label}</div>
      <div className="control-device-dots">
        {dots.map((dot) => (
          <span
            key={dot.key}
            className={`control-device-dot ${dot.className}`}
            title={dot.title}
          />
        ))}
        {dots.length === 0 && <span className="control-device-empty">--</span>}
      </div>
    </div>
  )
}

function HardwareSummary({ hwStatus, busy, state, owner }: {
  hwStatus: HardwareStatus | null
  busy: boolean
  state: string
  owner: string
}) {
  const { t } = useI18n()
  const hwReady = hwStatus?.ready ?? false
  const warningCount = hwStatus?.missing.length ?? 0
  const readinessText = hwReady ? t('hwReady') : `${warningCount} ${t('warnings')}`
  const armDots = hwStatus?.arms.map((arm) => ({
    key: arm.alias,
    title: arm.alias,
    className: !arm.connected ? 'bg-rd' : !arm.calibrated ? 'bg-yl' : 'bg-gn',
  })) ?? []
  const cameraDots = hwStatus?.cameras.map((camera) => ({
    key: camera.alias,
    title: camera.alias,
    className: camera.connected ? 'bg-gn' : 'bg-rd',
  })) ?? []

  return (
    <div className="control-hardware-summary">
      <DeviceDots label={t('arms')} dots={armDots} />
      <DeviceDots label={t('cameras')} dots={cameraDots} />
      <div className="control-hardware-state">
        <div className={`control-hardware-readiness ${hwReady ? 'is-ready' : 'is-warning'}`}>
          {readinessText}
        </div>
        {busy && <div className="control-hardware-busy">{state}{owner ? ` · ${owner}` : ''}</div>}
      </div>
    </div>
  )
}

function TeleopPanel({
  state,
  loading,
  hwStatus,
  owner,
  onStart,
  onStop,
}: {
  state: SessionState
  loading: string | null
  hwStatus: any
  owner: string
  onStart: () => void
  onStop: () => void
}) {
  const { t } = useI18n()
  const teleopCapability = capabilityOf(hwStatus, 'teleop')
  const teleopStopping = loading === 'teleop-stop' || (state === 'stopping' && owner === 'teleop')
  const busy = state !== 'idle' && state !== 'error'
  const busyReason = busy ? `${state}${owner ? ` · ${owner}` : ''}` : ''

  return (
    <section className="control-teleop-panel bg-sf rounded-lg p-3.5 shadow-card">
      <h3 className="mb-3 text-2xs font-mono uppercase tracking-widest text-tx3">{t('teleoperation')}</h3>
      <div className="grid gap-2">
        <ActionBtn
          color="ac"
          disabled={!canStart(state) || !teleopCapability.ready || !!loading}
          onClick={onStart}
          title={busy ? busyReason : capabilityReason(teleopCapability) || undefined}
        >
          {loading === 'teleop' ? t('startingTeleop') : t('startTeleop')}
        </ActionBtn>
        <ActionBtn color="yl" disabled={state !== 'teleoperating' || !!loading} onClick={onStop}>
          {teleopStopping ? t('stoppingTeleop') : t('stopTeleop')}
        </ActionBtn>
      </div>
      {(loading === 'teleop' || state === 'teleoperating' || teleopStopping) && (
        <div className={`mt-3 flex items-center gap-2 text-xs font-medium ${teleopStopping ? 'text-yl' : 'text-ac'}`}>
          <span className={`h-2 w-2 rounded-full animate-pulse ${teleopStopping ? 'bg-yl' : 'bg-ac'}`} />
          {loading === 'teleop'
            ? t('hwInitializing')
            : teleopStopping
              ? t('stoppingTeleop')
              : t('stateTeleoperating')}
        </div>
      )}
    </section>
  )
}

function CollectionRunPanel({
  collectionStatus,
  assignments,
  targetDate,
  serverToday,
  selectedAssignmentId,
  session,
  loading,
  onSelect,
  onStart,
  onStop,
  onSave,
  onDiscard,
  onSkipReset,
  onRetryPending,
}: {
  collectionStatus: CollectionStatus | null
  assignments: Assignment[]
  targetDate: string
  serverToday: string
  selectedAssignmentId: string
  session: SessionStatus
  loading: boolean
  onSelect: (assignmentId: string) => void
  onStart: (assignment: Assignment) => void
  onStop: () => void
  onSave: () => void
  onDiscard: () => void
  onSkipReset: () => void
  onRetryPending: () => void
}) {
  const active = collectionStatus?.active_run
  const selectedAssignment = useMemo(
    () => assignments.find((assignment) => assignment.id === selectedAssignmentId) || null,
    [assignments, selectedAssignmentId],
  )
  const targetEpisodes = session.target_episodes || active?.task_params.num_episodes || 0
  const pct = targetEpisodes > 0 ? Math.min(100, Math.round((session.saved_episodes / targetEpisodes) * 100)) : 0
  const canControlEpisode = session.record_phase === 'recording' && !session.record_pending_command
  const canSkipResetWait = session.record_phase === 'resetting' && !session.record_pending_command
  const hasError = sessionHasError(session, collectionStatus)
  const errorText = sessionErrorText(session, collectionStatus)
  const busyWithoutActive = session.state !== 'idle'
  const viewingToday = targetDate === serverToday
  const taskSelectionDisabled = loading || hasError || busyWithoutActive
  const selectedCanStart = Boolean(
    selectedAssignment
      && !loading
      && !hasError
      && !busyWithoutActive
      && viewingToday
      && selectedAssignment.is_active,
  )

  if (!active) {
    return (
      <>
        {collectionStatus && collectionStatus.pending_finish_count > 0 && (
          <div className="collection-warning">
            <span>{collectionStatus.pending_finish_count} 个 finish 等待同步</span>
            <ActionButton variant="warning" onClick={onRetryPending} disabled={loading}>重试同步</ActionButton>
          </div>
        )}

        {hasError && (
          <div className="collection-warning collection-warning--error">
            <span>Session error：{errorText}</span>
            <ActionButton variant="danger" onClick={onStop} disabled={loading}>结束采集</ActionButton>
          </div>
        )}

        {selectedAssignment && (
          <section className="collection-panel collection-panel--wide">
            <div className="collection-panel__head">
              <div>
                <h3>录制</h3>
                <span>{selectedAssignment.task_params.task}</span>
              </div>
              <div className="collection-task-card__meta">
                <span>{formatHours(selectedAssignment.completed_seconds)} / {formatHours(selectedAssignment.target_seconds)}</span>
                <span>{selectedAssignment.task_params.fps} fps</span>
                <span>{selectedAssignment.task_params.num_episodes} eps</span>
              </div>
              <ActionButton
                onClick={() => onStart(selectedAssignment)}
                disabled={!selectedCanStart}
              >
                开始录制
              </ActionButton>
            </div>
            {!viewingToday && (
              <div className="collection-warning">
                <span>只能启动今天的任务；当前查看 {targetDate}，今天是 {serverToday}</span>
              </div>
            )}
            {hasError && (
              <div className="collection-error">
                error 未清理前不能开始录制。点击上方“结束采集”清掉本地错误。
              </div>
            )}
          </section>
        )}

        <div className="collection-grid">
          {assignments.map((assignment) => {
            const assignmentPct = assignmentProgressPct(assignment)
            const isSelected = assignment.id === selectedAssignmentId
            const disabled = taskSelectionDisabled || !assignment.is_active
            return (
              <button
                className={`collection-task-card ${isSelected ? 'collection-task-card--selected' : ''}`}
                key={assignment.id}
                type="button"
                disabled={disabled}
                aria-pressed={isSelected}
                onClick={() => onSelect(assignment.id)}
              >
                <div className="collection-task-card__head">
                  <div>
                    <h3>{assignment.task_params.task}</h3>
                  </div>
                  <span>{assignmentPct}%</span>
                </div>
                <div className="collection-progress">
                  <span style={{ width: `${assignmentPct}%` }} />
                </div>
                <div className="collection-task-card__meta">
                  <span>{formatHours(assignment.completed_seconds)} / {formatHours(assignment.target_seconds)}</span>
                  <span>{assignment.task_params.fps} fps</span>
                  <span>{assignment.task_params.num_episodes} eps</span>
                </div>
                <div className="collection-task-card__state">
                  {isSelected ? '已选择' : assignment.is_active ? '选择任务' : '已停用'}
                </div>
              </button>
            )
          })}
        </div>

        {assignments.length === 0 && (
          <div className="collection-empty collection-empty--control">
            <div className="collection-empty__eyebrow">数据采集</div>
            <div className="collection-empty__center">
              <div className="collection-empty__title">没有任务</div>
              <div className="collection-empty__caption">{targetDate}</div>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <section className="bg-sf rounded-lg p-5 shadow-card">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="text-2xs font-mono uppercase tracking-widest text-tx3">Collection</div>
          <h2 className="mt-2 text-xl font-bold text-tx">正在采集</h2>
          <p className="mt-1 text-sm text-tx2">{active.dataset_name}</p>
          <p className="mt-2 max-w-3xl text-sm text-tx">{active.task_params.task}</p>
        </div>
        <div className="grid min-w-[280px] grid-cols-2 gap-2 text-sm lg:grid-cols-4">
          <div className="rounded-lg bg-sf2 p-3">
            <div className="text-2xs font-mono uppercase tracking-widest text-tx3">Episodes</div>
            <div className="mt-1 text-lg font-bold text-tx">{session.saved_episodes}/{targetEpisodes}</div>
          </div>
          <div className="rounded-lg bg-sf2 p-3">
            <div className="text-2xs font-mono uppercase tracking-widest text-tx3">Frames</div>
            <div className="mt-1 text-lg font-bold text-tx">{session.total_frames}</div>
          </div>
          <div className="rounded-lg bg-sf2 p-3">
            <div className="text-2xs font-mono uppercase tracking-widest text-tx3">Phase</div>
            <div className="mt-1 text-lg font-bold text-tx">{session.record_phase || session.state}</div>
          </div>
          <div className="rounded-lg bg-sf2 p-3">
            <div className="text-2xs font-mono uppercase tracking-widest text-tx3">Elapsed</div>
            <div className="mt-1 text-lg font-bold text-tx">{formatSeconds(Math.round(session.elapsed_seconds || 0))}</div>
          </div>
        </div>
      </div>

      {hasError && (
        <div className="collection-warning collection-warning--error mt-4">
          <span>Session error：{errorText}</span>
          <ActionButton variant="danger" onClick={onStop} disabled={loading}>结束采集</ActionButton>
        </div>
      )}

      <div className="mt-4 h-2 overflow-hidden rounded-full bg-sf2">
        <div
          className="h-full rounded-full bg-gradient-to-r from-ac2 to-ac transition-all duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <ActionBtn color="gn" disabled={loading || !canControlEpisode} onClick={onSave}>
          保存 episode
        </ActionBtn>
        <ActionBtn color="yl" disabled={loading || !canControlEpisode} onClick={onDiscard}>
          重置 episode
        </ActionBtn>
        {session.record_phase === 'resetting' && (
          <ActionBtn color="ac" disabled={loading || !canSkipResetWait} onClick={onSkipReset}>
            跳过等待
          </ActionBtn>
        )}
        <ActionBtn color="rd" disabled={loading} onClick={onStop}>
          结束采集
        </ActionBtn>
      </div>
    </section>
  )
}

export default function ControlPage() {
  const session = useSessionStore((store) => store.session)
  const loading = useSessionStore((store) => store.loading)
  const fetchSessionStatus = useSessionStore((store) => store.fetchSessionStatus)
  const doTeleopStart = useSessionStore((store) => store.doTeleopStart)
  const doTeleopStop = useSessionStore((store) => store.doTeleopStop)
  const doSaveEpisode = useSessionStore((store) => store.doSaveEpisode)
  const doDiscardEpisode = useSessionStore((store) => store.doDiscardEpisode)
  const doSkipReset = useSessionStore((store) => store.doSkipReset)
  const hwStatus = useHardwareStore((store) => store.hardwareStatus)
  const fetchHardwareStatus = useHardwareStore((store) => store.fetchHardwareStatus)
  const [collectionStatus, setCollectionStatus] = useState<CollectionStatus | null>(null)
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [serverToday, setServerToday] = useState(todayIso())
  const [targetDate, setTargetDate] = useState(todayIso())
  const [selectedAssignmentId, setSelectedAssignmentId] = useState('')
  const [collectionError, setCollectionError] = useState('')
  const [collectionNotice, setCollectionNotice] = useState('')
  const [collectionLoading, setCollectionLoading] = useState(false)

  const busy = session.state !== 'idle' && session.state !== 'error'

  async function refreshCollectionStatus() {
    const [nextAssignments, nextStatus] = await Promise.all([
      collectionApi.getAssignments(targetDate),
      collectionApi.getStatus(),
      fetchSessionStatus(),
    ])
    setAssignments(nextAssignments)
    setCollectionStatus(nextStatus)
  }

  async function refreshToday() {
    const next = await collectionApi.getToday()
    setServerToday(next.today)
    setTargetDate(next.today)
  }

  useEffect(() => {
    void fetchHardwareStatus()
    void refreshCollectionStatus().catch((err) => setCollectionError(err instanceof Error ? err.message : String(err)))
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchHardwareStatus()
        void refreshCollectionStatus().catch((err) => setCollectionError(err instanceof Error ? err.message : String(err)))
      }
    }, COLLECTION_REFRESH_MS)
    return () => clearInterval(timer)
  }, [fetchHardwareStatus, fetchSessionStatus, targetDate])

  useEffect(() => {
    void refreshToday().catch((err) => setCollectionError(err instanceof Error ? err.message : String(err)))
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshToday().catch((err) => setCollectionError(err instanceof Error ? err.message : String(err)))
      }
    }, TODAY_REFRESH_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    const activeAssignmentId = collectionStatus?.active_run?.assignment_id
    if (activeAssignmentId) {
      setSelectedAssignmentId(activeAssignmentId)
    }
  }, [collectionStatus?.active_run?.assignment_id])

  useEffect(() => {
    if (!selectedAssignmentId || collectionStatus?.active_run) return
    if (!assignments.some((assignment) => assignment.id === selectedAssignmentId)) {
      setSelectedAssignmentId('')
    }
  }, [assignments, collectionStatus?.active_run, selectedAssignmentId])

  async function runCollectionAction(action: () => Promise<void>) {
    setCollectionLoading(true)
    setCollectionError('')
    setCollectionNotice('')
    try {
      await action()
      await refreshCollectionStatus()
    } catch (err) {
      setCollectionError(err instanceof Error ? err.message : String(err))
    } finally {
      setCollectionLoading(false)
    }
  }

  async function stopCollectionRun() {
    await runCollectionAction(async () => {
      const result = await collectionApi.stopRun()
      if (result.status === 'pending_cloud_finish') {
        setCollectionError(`本地采集已结束，云端 finish 待重试：${result.detail || ''}`)
        return
      }
      if (result.status === 'failed' && result.run) {
        setCollectionError(`采集进程已异常退出，已释放任务：${result.local_stop_error || result.run.status || ''}`)
        return
      }
      if (result.status === 'failed') {
        setCollectionNotice(`本地错误已清理${result.local_stop_error ? `：${result.local_stop_error}` : ''}`)
        return
      }
      if (result.status === 'idle') {
        setCollectionNotice('当前没有进行中的采集')
      }
    })
  }

  async function startCollectionRun(assignment: Assignment) {
    await runCollectionAction(async () => {
      await collectionApi.startRun(assignment.id)
      setSelectedAssignmentId(assignment.id)
    })
  }

  async function retryPendingFinish() {
    await runCollectionAction(async () => {
      await collectionApi.retryPending()
    })
  }

  return (
    <div className="control-page page-enter flex h-full flex-col overflow-y-auto">
      {collectionError && (
        <div className="border-b border-rd/30 border-l-4 border-l-rd bg-rd/10 px-4 py-2 text-sm font-medium text-rd">
          {collectionError}
        </div>
      )}
      {collectionNotice && (
        <div className="border-b border-ac/30 border-l-4 border-l-ac bg-ac/10 px-4 py-2 text-sm font-medium text-ac">
          {collectionNotice}
        </div>
      )}

      <div className="space-y-3 p-4">
        <div className="control-status-stack">
          <HardwareSummary
            hwStatus={hwStatus}
            busy={busy}
            state={session.state}
            owner={session.embodiment_owner}
          />
          <TeleopPanel
            state={session.state}
            loading={loading}
            hwStatus={hwStatus}
            owner={session.embodiment_owner}
            onStart={() => { void doTeleopStart() }}
            onStop={() => { void doTeleopStop() }}
          />
        </div>

        <CollectionRunPanel
          collectionStatus={collectionStatus}
          assignments={assignments}
          targetDate={targetDate}
          serverToday={serverToday}
          selectedAssignmentId={selectedAssignmentId}
          session={session}
          loading={collectionLoading || Boolean(loading)}
          onSelect={setSelectedAssignmentId}
          onStart={(assignment) => { void startCollectionRun(assignment) }}
          onStop={() => { void stopCollectionRun() }}
          onSave={() => { void runCollectionAction(doSaveEpisode) }}
          onDiscard={() => { void runCollectionAction(doDiscardEpisode) }}
          onSkipReset={() => { void runCollectionAction(doSkipReset) }}
          onRetryPending={() => { void retryPendingFinish() }}
        />
      </div>
    </div>
  )
}
