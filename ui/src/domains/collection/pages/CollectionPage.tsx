import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { collectionApi, type Assignment, type CollectionStatus } from '@/domains/collection/api/collectionApi'
import { useSessionStore } from '@/domains/session/store/useSessionStore'
import { useAuthStore } from '@/shared/lib/authStore'
import { ActionButton, StatusPill } from '@/shared/ui'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function formatHours(seconds: number) {
  const hours = seconds / 3600
  return `${hours.toFixed(hours >= 10 ? 0 : 1)} h`
}

function progressPct(item: Assignment) {
  if (item.target_seconds <= 0) return 0
  return Math.min(100, Math.round((item.completed_seconds / item.target_seconds) * 100))
}

export default function CollectionPage() {
  const navigate = useNavigate()
  const { isLoggedIn, user, isChecking } = useAuthStore()
  const session = useSessionStore((state) => state.session)
  const fetchSessionStatus = useSessionStore((state) => state.fetchSessionStatus)
  const doSaveEpisode = useSessionStore((state) => state.doSaveEpisode)
  const doDiscardEpisode = useSessionStore((state) => state.doDiscardEpisode)
  const doSkipReset = useSessionStore((state) => state.doSkipReset)
  const [targetDate, setTargetDate] = useState(todayIso())
  const [assignments, setAssignments] = useState<Assignment[]>([])
  const [status, setStatus] = useState<CollectionStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const activeAssignmentId = status?.active_run?.assignment_id || null
  const totalTargetSeconds = assignments.reduce((sum, item) => sum + item.target_seconds, 0)
  const totalCompletedSeconds = assignments.reduce((sum, item) => sum + item.completed_seconds, 0)
  const totalProgress = totalTargetSeconds > 0 ? Math.min(100, Math.round((totalCompletedSeconds / totalTargetSeconds) * 100)) : 0
  const canControlEpisode = session.record_phase === 'recording' && !session.record_pending_command
  const canSkipResetWait = session.record_phase === 'resetting' && !session.record_pending_command
  const activeAssignment = useMemo(
    () => assignments.find((item) => item.id === activeAssignmentId) || null,
    [activeAssignmentId, assignments],
  )

  async function refresh() {
    if (!isLoggedIn) return
    const [nextAssignments, nextStatus] = await Promise.all([
      collectionApi.getAssignments(targetDate),
      collectionApi.getStatus(),
      fetchSessionStatus(),
    ])
    setAssignments(nextAssignments)
    setStatus(nextStatus)
  }

  useEffect(() => {
    if (!isLoggedIn) return
    let cancelled = false
    async function load() {
      try {
        setError('')
        const [nextAssignments, nextStatus] = await Promise.all([
          collectionApi.getAssignments(targetDate),
          collectionApi.getStatus(),
          fetchSessionStatus(),
        ])
        if (cancelled) return
        setAssignments(nextAssignments)
        setStatus(nextStatus)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [fetchSessionStatus, isLoggedIn, targetDate])

  async function start(assignment: Assignment) {
    setLoading(true)
    setError('')
    try {
      await collectionApi.startRun(assignment.id)
      await refresh()
      navigate('/control')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function stop() {
    setLoading(true)
    setError('')
    try {
      const result = await collectionApi.stopRun()
      if (result.status === 'pending_cloud_finish') {
        setError(`本地录制已结束，云端 finish 待重试：${result.detail || ''}`)
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function retryPending() {
    setLoading(true)
    setError('')
    try {
      await collectionApi.retryPending()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function episodeAction(action: () => Promise<void>) {
    setLoading(true)
    setError('')
    try {
      await action()
      await fetchSessionStatus()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  if (isChecking) {
    return <div className="collection-page"><div className="collection-empty">Checking account...</div></div>
  }

  if (!isLoggedIn) {
    navigate('/login', { replace: true })
    return null
  }

  return (
    <div className="collection-page">
      <div className="collection-toolbar">
        <div>
          <div className="eyebrow">Collection</div>
          <h2 className="collection-title">采集中心</h2>
        </div>
        <div className="collection-toolbar__actions">
          <input
            className="collection-input collection-input--date"
            type="date"
            value={targetDate}
            onChange={(event) => setTargetDate(event.target.value)}
          />
          {user?.level === 'admin' && (
            <Link className="collection-link-button collection-link-button--primary" to="/collection/admin">任务发布</Link>
          )}
        </div>
      </div>

      <div className="collection-summary">
        <div className="collection-summary__main">
          <span>总进度</span>
          <strong>{formatHours(totalCompletedSeconds)} / {formatHours(totalTargetSeconds)}</strong>
        </div>
        <div className="collection-progress">
          <span style={{ width: `${totalProgress}%` }} />
        </div>
        <StatusPill active={Boolean(status?.active_run)}>
          {status?.active_run ? '采集中' : 'Idle'}
        </StatusPill>
      </div>

      {error && <div className="collection-error">{error}</div>}

      {status && status.pending_finish_count > 0 && (
        <div className="collection-warning">
          <span>{status.pending_finish_count} 个 finish 等待同步</span>
          <ActionButton variant="warning" onClick={retryPending} disabled={loading}>重试同步</ActionButton>
        </div>
      )}

      {activeAssignment && (
        <section className="collection-active">
          <div>
            <div className="collection-active__label">当前任务</div>
            <h3>{activeAssignment.task_params.task}</h3>
            <p>{status?.active_run?.dataset_name}</p>
          </div>
          <div className="collection-session-metrics">
            <span>Episode {session.saved_episodes}/{session.target_episodes || activeAssignment.task_params.num_episodes}</span>
            <span>{session.total_frames} frames</span>
            <span>{session.record_phase}</span>
          </div>
          <div className="collection-active__actions">
            <ActionButton variant="success" onClick={() => episodeAction(doSaveEpisode)} disabled={loading || !canControlEpisode}>保存 episode</ActionButton>
            <ActionButton variant="warning" onClick={() => episodeAction(doDiscardEpisode)} disabled={loading || !canControlEpisode}>重置 episode</ActionButton>
            {session.record_phase === 'resetting' && (
              <ActionButton variant="primary" onClick={() => episodeAction(doSkipReset)} disabled={loading || !canSkipResetWait}>跳过等待</ActionButton>
            )}
            <ActionButton variant="danger" onClick={stop} disabled={loading}>结束采集</ActionButton>
          </div>
        </section>
      )}

      <div className="collection-grid">
        {assignments.map((assignment) => {
          const pct = progressPct(assignment)
          const isActive = activeAssignmentId === assignment.id
          const disabled = loading || Boolean(activeAssignmentId) || !assignment.is_active
          return (
            <article className="collection-task-card" key={assignment.id}>
              <div className="collection-task-card__head">
                <div>
                  <h3>{assignment.task_params.task}</h3>
                </div>
                <span>{pct}%</span>
              </div>
              <div className="collection-progress">
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="collection-task-card__meta">
                <span>{formatHours(assignment.completed_seconds)} / {formatHours(assignment.target_seconds)}</span>
                <span>{assignment.task_params.fps} fps</span>
                <span>{assignment.task_params.num_episodes} eps</span>
              </div>
              <ActionButton
                variant={isActive ? 'secondary' : 'primary'}
                disabled={disabled}
                onClick={() => start(assignment)}
              >
                {isActive ? '采集中' : '开始采集'}
              </ActionButton>
            </article>
          )
        })}
      </div>

      {assignments.length === 0 && (
        <div className="collection-empty">
          <div className="collection-empty__title">没有任务</div>
          <div className="collection-empty__caption">{targetDate}</div>
        </div>
      )}
    </div>
  )
}
