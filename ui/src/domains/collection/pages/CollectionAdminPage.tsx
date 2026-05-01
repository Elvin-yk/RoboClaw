import { FormEvent, useEffect, useMemo, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  collectionApi,
  type Assignment,
  type CollectionTask,
  type TaskPayload,
} from '@/domains/collection/api/collectionApi'
import { useAuthStore } from '@/shared/lib/authStore'
import { ActionButton } from '@/shared/ui'

function todayIso() {
  return new Date().toISOString().slice(0, 10)
}

function secondsToHours(seconds: number) {
  return (seconds / 3600).toFixed(1)
}

function progressPct(item: Assignment) {
  if (item.target_seconds <= 0) return 0
  return Math.min(100, Math.round((item.completed_seconds / item.target_seconds) * 100))
}

function normalizePhoneRows(rows: string[]) {
  return Array.from(new Set(rows.map((item) => item.trim()).filter(Boolean)))
}

function invalidPhones(phones: string[]) {
  return phones.filter((phone) => !/^1\d{10}$/.test(phone))
}

const emptyTask: TaskPayload = {
  description: '',
  task_prompt: '',
  num_episodes: 1,
  fps: 30,
  episode_time_s: 300,
  reset_time_s: 10,
  use_cameras: true,
  dataset_prefix: 'rec',
  is_active: true,
}

export default function CollectionAdminPage() {
  const { user, isLoggedIn, isChecking } = useAuthStore()
  const [view, setView] = useState<'publish' | 'progress'>('publish')
  const [tasks, setTasks] = useState<CollectionTask[]>([])
  const [progress, setProgress] = useState<Assignment[]>([])
  const [taskForm, setTaskForm] = useState<TaskPayload>(emptyTask)
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [phoneRows, setPhoneRows] = useState([''])
  const [targetDate, setTargetDate] = useState(todayIso())
  const [allDates, setAllDates] = useState(false)
  const [targetHours, setTargetHours] = useState('3')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const activeTasks = useMemo(() => tasks.filter((task) => task.is_active), [tasks])
  const progressDate = allDates ? undefined : targetDate
  const totalTargetSeconds = progress.reduce((sum, item) => sum + item.target_seconds, 0)
  const totalCompletedSeconds = progress.reduce((sum, item) => sum + item.completed_seconds, 0)

  async function refresh() {
    const [nextTasks, nextProgress] = await Promise.all([
      collectionApi.listTasks(),
      collectionApi.getProgress(progressDate),
    ])
    setTasks(nextTasks)
    setProgress(nextProgress)
    if (!selectedTaskId && nextTasks.length > 0) {
      setSelectedTaskId(nextTasks[0].id)
    }
  }

  useEffect(() => {
    if (!isLoggedIn || user?.level !== 'admin') return
    let cancelled = false
    async function load() {
      try {
        setError('')
        const [nextTasks, nextProgress] = await Promise.all([
          collectionApi.listTasks(),
          collectionApi.getProgress(progressDate),
        ])
        if (cancelled) return
        setTasks(nextTasks)
        setProgress(nextProgress)
        if (!selectedTaskId && nextTasks.length > 0) {
          setSelectedTaskId(nextTasks[0].id)
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [allDates, isLoggedIn, progressDate, selectedTaskId, targetDate, user?.level])

  async function createTask(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const created = await collectionApi.createTask(taskForm)
      setTaskForm(emptyTask)
      setSelectedTaskId(created.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function assignTask(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const phones = normalizePhoneRows(phoneRows)
      const invalid = invalidPhones(phones)
      if (phones.length === 0) {
        throw new Error('请输入手机号')
      }
      if (invalid.length > 0) {
        throw new Error(`手机号格式不正确：${invalid.join(', ')}`)
      }
      for (const phone of phones) {
        await collectionApi.upsertAssignment({
          phone,
          task_id: selectedTaskId,
          target_date: targetDate,
          target_seconds: Math.round(Number(targetHours) * 3600),
          is_active: true,
        })
      }
      setPhoneRows([''])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function updatePhoneRow(index: number, value: string) {
    setPhoneRows((rows) => rows.map((row, rowIndex) => (rowIndex === index ? value : row)))
  }

  function addPhoneRow() {
    setPhoneRows((rows) => [...rows, ''])
  }

  function removePhoneRow(index: number) {
    setPhoneRows((rows) => (rows.length === 1 ? [''] : rows.filter((_, rowIndex) => rowIndex !== index)))
  }

  if (isChecking) {
    return <div className="collection-page"><div className="collection-empty">Checking account...</div></div>
  }

  if (!isLoggedIn || user?.level !== 'admin') {
    return <Navigate to="/control" replace />
  }

  return (
    <div className="collection-page">
      <div className="collection-toolbar">
        <div>
          <div className="eyebrow">Admin</div>
          <h2 className="collection-title">任务发布</h2>
        </div>
        <div className="collection-toolbar__actions">
          <div className="collection-tabs" role="tablist" aria-label="采集管理视图">
            <button
              type="button"
              className={view === 'publish' ? 'collection-tab collection-tab--active' : 'collection-tab'}
              onClick={() => setView('publish')}
            >
              任务发布
            </button>
            <button
              type="button"
              className={view === 'progress' ? 'collection-tab collection-tab--active' : 'collection-tab'}
              onClick={() => setView('progress')}
            >
              全部进度
            </button>
          </div>
          <button
            type="button"
            className={allDates ? 'collection-link-button collection-link-button--primary' : 'collection-link-button'}
            onClick={() => setAllDates((value) => !value)}
          >
            全部日期
          </button>
          <input
            className="collection-input collection-input--date"
            type="date"
            value={targetDate}
            disabled={allDates}
            onChange={(event) => setTargetDate(event.target.value)}
          />
        </div>
      </div>

      {error && <div className="collection-error">{error}</div>}

      {view === 'publish' && (
        <div className="collection-admin-layout">
          <form className="collection-panel" onSubmit={createTask}>
            <h3>创建任务</h3>
            <label>
              <span>任务描述</span>
              <textarea className="collection-input collection-textarea" value={taskForm.task_prompt} onChange={(event) => setTaskForm({ ...taskForm, task_prompt: event.target.value })} required />
            </label>
            <div className="collection-form-grid">
              <label>
                <span>Episodes</span>
                <input className="collection-input" type="number" min={1} value={taskForm.num_episodes} onChange={(event) => setTaskForm({ ...taskForm, num_episodes: Number(event.target.value) })} />
              </label>
              <label>
                <span>FPS</span>
                <input className="collection-input" type="number" min={1} value={taskForm.fps} onChange={(event) => setTaskForm({ ...taskForm, fps: Number(event.target.value) })} />
              </label>
              <label>
                <span>Episode 秒</span>
                <input className="collection-input" type="number" min={1} value={taskForm.episode_time_s} onChange={(event) => setTaskForm({ ...taskForm, episode_time_s: Number(event.target.value) })} />
              </label>
              <label>
                <span>Reset 秒</span>
                <input className="collection-input" type="number" min={0} value={taskForm.reset_time_s} onChange={(event) => setTaskForm({ ...taskForm, reset_time_s: Number(event.target.value) })} />
              </label>
            </div>
            <div className="collection-form-grid">
              <label>
                <span>Dataset prefix</span>
                <input className="collection-input" value={taskForm.dataset_prefix} onChange={(event) => setTaskForm({ ...taskForm, dataset_prefix: event.target.value })} required />
              </label>
              <label className="collection-checkbox">
                <input type="checkbox" checked={taskForm.use_cameras} onChange={(event) => setTaskForm({ ...taskForm, use_cameras: event.target.checked })} />
                <span>使用相机</span>
              </label>
            </div>
            <ActionButton type="submit" disabled={loading}>创建</ActionButton>
          </form>

          <form className="collection-panel" onSubmit={assignTask}>
            <h3>分配任务</h3>
            <label>
              <span>任务</span>
              <select className="collection-input" value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)} required>
                {activeTasks.map((task) => (
                  <option key={task.id} value={task.id}>{task.task_prompt}</option>
                ))}
              </select>
            </label>
            <label>
              <span>手机号</span>
              <div className="collection-phone-list">
                {phoneRows.map((phone, index) => (
                  <div className="collection-phone-row" key={index}>
                    <input
                      className="collection-input"
                      value={phone}
                      onChange={(event) => updatePhoneRow(index, event.target.value)}
                      placeholder="13800000000"
                      required={index === 0}
                    />
                    <button
                      className="collection-icon-button"
                      type="button"
                      onClick={addPhoneRow}
                      aria-label="添加手机号"
                    >
                      +
                    </button>
                    <button
                      className="collection-icon-button collection-icon-button--muted"
                      type="button"
                      onClick={() => removePhoneRow(index)}
                      disabled={phoneRows.length === 1 && !phone}
                      aria-label="删除手机号"
                    >
                      -
                    </button>
                  </div>
                ))}
              </div>
            </label>
            <label>
              <span>目标小时</span>
              <input className="collection-input" type="number" min={0.1} step={0.1} value={targetHours} onChange={(event) => setTargetHours(event.target.value)} />
            </label>
            <ActionButton type="submit" disabled={loading || !selectedTaskId || normalizePhoneRows(phoneRows).length === 0}>发布/更新</ActionButton>
          </form>
        </div>
      )}

      <section className="collection-panel collection-panel--wide">
        <div className="collection-panel__head">
          <h3>{allDates ? '全部进度' : `${targetDate} 进度`}</h3>
          <span>{progress.length} 个分配 · {secondsToHours(totalCompletedSeconds)} / {secondsToHours(totalTargetSeconds)} h</span>
        </div>
        <div className="collection-progress-list">
          {progress.map((item) => {
            const pct = progressPct(item)
            return (
              <div className="collection-progress-row" key={item.id}>
                <div>
                  <strong>{item.task_params.task}</strong>
                  <span>{item.target_date} · {item.phone}{item.user_nickname ? ` · ${item.user_nickname}` : ''}</span>
                </div>
                <div className="collection-progress-row__bar"><span style={{ width: `${pct}%` }} /></div>
                <div className="collection-progress-row__value">
                  {secondsToHours(item.completed_seconds)} / {secondsToHours(item.target_seconds)} h
                </div>
              </div>
            )
          })}
          {progress.length === 0 && <div className="collection-empty collection-empty--compact">暂无分配</div>}
        </div>
      </section>
    </div>
  )
}
