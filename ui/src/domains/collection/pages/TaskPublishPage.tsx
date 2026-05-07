import { type DragEvent, FormEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Navigate } from 'react-router-dom'
import {
  collectionApi,
  type Assignment,
  type CollectionTask,
  type TaskPayload,
} from '@/domains/collection/api/collectionApi'
import OrganizationMemberPicker from '@/domains/collection/components/OrganizationMemberPicker'
import { createMemberInputResolver } from '@/domains/collection/lib/memberInput'
import { assignmentProgressPct, formatHours, todayIso } from '@/domains/collection/lib/metrics'
import { useAuthStore } from '@/shared/lib/authStore'
import {
  canManageCollection,
  canManageOrganization,
  canManageOrganizationMembers,
  currentMembershipRole,
  evoApi,
  INVITE_ROLES,
  isInviteRole,
  membershipRoleLabel,
  type CurrentOrganization,
  type InviteRole,
  type OrganizationMember,
} from '@/shared/api/evoClient'
import { cn } from '@/shared/lib/cn'
import { isValidPhone, maskPhone } from '@/shared/lib/phone'
import { ActionButton } from '@/shared/ui'

function secondsToHourValue(seconds: number) {
  return (seconds / 3600).toFixed(1)
}

function countPublishedAssignments(items: Assignment[]) {
  return items.reduce<Record<string, number>>((counts, item) => {
    counts[item.task_id] = (counts[item.task_id] || 0) + 1
    return counts
  }, {})
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

const EMPTY_ORGANIZATION_MEMBERS: OrganizationMember[] = []

interface AssignmentEditState {
  id: string
  phone: string
  task_id: string
  target_date: string
  target_hours: string
  is_active: boolean
}

type TaskDialogState =
  | { mode: 'closed' }
  | { mode: 'create'; draft: TaskPayload }
  | { mode: 'details'; taskId: string }
  | { mode: 'edit'; taskId: string; draft: TaskPayload }
  | { mode: 'publish'; taskId: string }
  | { mode: 'delete'; taskId: string }

function assignmentToEditState(item: Assignment): AssignmentEditState {
  return {
    id: item.id,
    phone: item.phone,
    task_id: item.task_id,
    target_date: item.target_date,
    target_hours: secondsToHourValue(item.target_seconds),
    is_active: item.is_active,
  }
}

function taskToPayload(task: CollectionTask): TaskPayload {
  return {
    name: task.name,
    description: task.description || '',
    task_prompt: task.task_prompt,
    num_episodes: task.num_episodes,
    fps: task.fps,
    episode_time_s: task.episode_time_s,
    reset_time_s: task.reset_time_s,
    use_cameras: task.use_cameras,
    dataset_prefix: task.dataset_prefix,
    is_active: task.is_active,
  }
}

async function loadPublishData(progressDate: string | undefined) {
  const progressRequest = collectionApi.getProgress(progressDate)
  const allProgressRequest = progressDate ? collectionApi.getProgress() : progressRequest
  const [tasks, progress, allProgress] = await Promise.all([
    collectionApi.listTasks(),
    progressRequest,
    allProgressRequest,
  ])
  return { tasks, progress, publishCounts: countPublishedAssignments(allProgress) }
}

export default function TaskPublishPage() {
  const { user, isLoggedIn, isChecking } = useAuthStore()
  const membershipRole = currentMembershipRole(user)
  const currentOrganizationId = user?.current_membership?.organization.id ?? ''
  const canManageMembers = canManageOrganizationMembers(user)
  const [view, setView] = useState<'publish' | 'progress' | 'members'>('publish')
  const [tasks, setTasks] = useState<CollectionTask[]>([])
  const [progress, setProgress] = useState<Assignment[]>([])
  const [organization, setOrganization] = useState<CurrentOrganization | null>(null)
  const [taskDialog, setTaskDialog] = useState<TaskDialogState>({ mode: 'closed' })
  const [selectedTaskId, setSelectedTaskId] = useState('')
  const [publishCounts, setPublishCounts] = useState<Record<string, number>>({})
  const [draggingTaskId, setDraggingTaskId] = useState('')
  const [trashHover, setTrashHover] = useState(false)
  const [trashReady, setTrashReady] = useState(false)
  const [assignmentEditor, setAssignmentEditor] = useState<AssignmentEditState | null>(null)
  const [phoneRows, setPhoneRows] = useState([''])
  const [targetDate, setTargetDate] = useState(todayIso())
  const [allDates, setAllDates] = useState(false)
  const [targetHours, setTargetHours] = useState('3')
  const [memberPhone, setMemberPhone] = useState('')
  const [memberRole, setMemberRole] = useState<InviteRole>('member')
  const [memberNotice, setMemberNotice] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const activeTasks = useMemo(() => tasks.filter((task) => task.is_active), [tasks])
  const dialogTaskId = taskDialog.mode === 'closed' || taskDialog.mode === 'create' ? '' : taskDialog.taskId
  const dialogTask = useMemo(
    () => tasks.find((task) => task.id === dialogTaskId) || null,
    [dialogTaskId, tasks],
  )
  const taskDialogOpen = taskDialog.mode !== 'closed' && taskDialog.mode !== 'delete'
  const progressDate = allDates ? undefined : targetDate
  const totalTargetSeconds = progress.reduce((sum, item) => sum + item.target_seconds, 0)
  const totalCompletedSeconds = progress.reduce((sum, item) => sum + item.completed_seconds, 0)
  const canChooseInviteRole = canManageOrganization(user)
  const inviteRoleOptions: readonly InviteRole[] = canChooseInviteRole ? INVITE_ROLES : ['member']
  const effectiveInviteRole: InviteRole = canChooseInviteRole ? memberRole : 'member'
  const organizationMembers = organization?.members ?? EMPTY_ORGANIZATION_MEMBERS
  const visibleOrganizationMembers = useMemo(
    () => organizationMembers.filter((member) => member.status !== 'disabled'),
    [organizationMembers],
  )
  const memberInputResolver = useMemo(
    () => createMemberInputResolver(visibleOrganizationMembers),
    [visibleOrganizationMembers],
  )
  const resolvedPhoneRows = useMemo(
    () => memberInputResolver.resolveRows(phoneRows),
    [memberInputResolver, phoneRows],
  )
  const canPublishToMembers = resolvedPhoneRows.phones.length > 0 && resolvedPhoneRows.unresolved.length === 0
  const canInviteMember = Boolean(memberInputResolver.resolveInput(memberPhone))
  const trashReadyTimer = useRef<number | null>(null)

  function clearTrashReadyTimer() {
    if (trashReadyTimer.current !== null) {
      window.clearTimeout(trashReadyTimer.current)
      trashReadyTimer.current = null
    }
  }

  function resetTrashDragState() {
    clearTrashReadyTimer()
    setDraggingTaskId('')
    setTrashHover(false)
    setTrashReady(false)
  }

  function applyPublishData(next: Awaited<ReturnType<typeof loadPublishData>>) {
    setTasks(next.tasks)
    setProgress(next.progress)
    setPublishCounts(next.publishCounts)
    setTaskDialog((currentDialog) => {
      if (currentDialog.mode === 'closed' || currentDialog.mode === 'create') return currentDialog
      const taskExists = next.tasks.some((task) => task.id === currentDialog.taskId)
      return taskExists ? currentDialog : { mode: 'closed' }
    })
    setSelectedTaskId((currentTaskId) => {
      const currentTask = next.tasks.find((task) => task.id === currentTaskId && task.is_active)
      if (currentTask) return currentTaskId
      return next.tasks.find((task) => task.is_active)?.id || ''
    })
  }

  async function refresh() {
    applyPublishData(await loadPublishData(progressDate))
  }

  async function refreshOrganization() {
    setOrganization(await evoApi.getCurrentOrganization())
  }

  useEffect(() => {
    if (!isLoggedIn || !canManageCollection(user)) return
    let cancelled = false
    async function load() {
      try {
        setError('')
        const next = await loadPublishData(progressDate)
        if (cancelled) return
        applyPublishData(next)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [isLoggedIn, progressDate, user?.current_membership?.role_code])

  useEffect(() => {
    if (!isLoggedIn || !canManageCollection(user)) return
    if (view !== 'members' && taskDialog.mode !== 'publish') return
    if (organization?.id === currentOrganizationId) return
    let cancelled = false
    async function loadMembers() {
      try {
        setError('')
        const next = await evoApi.getCurrentOrganization()
        if (!cancelled) setOrganization(next)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    }
    void loadMembers()
    return () => {
      cancelled = true
    }
  }, [currentOrganizationId, isLoggedIn, organization?.id, taskDialog.mode, user, view])

  useEffect(() => () => clearTrashReadyTimer(), [])

  async function createTask(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      if (taskDialog.mode !== 'create') return
      const created = await collectionApi.createTask(taskDialog.draft)
      setTaskDialog({ mode: 'closed' })
      await refresh()
      setSelectedTaskId(created.id)
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
      const { phones, unresolved } = memberInputResolver.resolveRows(phoneRows)
      if (phones.length === 0) {
        throw new Error('请输入手机号或昵称')
      }
      if (unresolved.length > 0) {
        throw new Error(`成员不在当前组织或未选择：${unresolved.join(', ')}`)
      }
      if (taskDialog.mode !== 'publish') {
        throw new Error('请选择任务')
      }
      await Promise.all(
        phones.map((phone) => collectionApi.upsertAssignment({
          phone,
          task_id: taskDialog.taskId,
          target_date: targetDate,
          target_seconds: Math.round(Number(targetHours) * 3600),
          is_active: true,
        })),
      )
      setPhoneRows([''])
      await refresh()
      setTaskDialog({ mode: 'closed' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function updateAssignment(event: FormEvent) {
    event.preventDefault()
    if (!assignmentEditor) return
    setLoading(true)
    setError('')
    try {
      if (!isValidPhone(assignmentEditor.phone)) {
        throw new Error('手机号格式不正确')
      }
      await collectionApi.upsertAssignment({
        phone: assignmentEditor.phone.trim(),
        task_id: assignmentEditor.task_id,
        target_date: assignmentEditor.target_date,
        target_seconds: Math.round(Number(assignmentEditor.target_hours) * 3600),
        is_active: assignmentEditor.is_active,
      })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function updateTask(event: FormEvent) {
    event.preventDefault()
    if (taskDialog.mode !== 'edit') return
    setLoading(true)
    setError('')
    try {
      const taskId = taskDialog.taskId
      await collectionApi.updateTask(taskId, taskDialog.draft)
      await refresh()
      setTaskDialog({ mode: 'details', taskId })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function deleteTask() {
    if (taskDialog.mode !== 'delete') return
    setLoading(true)
    setError('')
    try {
      const taskId = taskDialog.taskId
      await collectionApi.deleteTask(taskId)
      if (selectedTaskId === taskId) {
        setSelectedTaskId('')
      }
      setTaskDialog({ mode: 'closed' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function inviteMember(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    setMemberNotice('')
    try {
      const phone = memberInputResolver.resolveInput(memberPhone)
      if (!phone) {
        throw new Error('请输入有效手机号，或从当前组织成员里选择昵称')
      }
      await evoApi.upsertOrganizationMember(phone, effectiveInviteRole)
      setMemberPhone('')
      setMemberRole('member')
      setMemberNotice('邀请已发送')
      await refreshOrganization()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function removeMember(member: OrganizationMember) {
    setLoading(true)
    setError('')
    setMemberNotice('')
    try {
      await evoApi.updateOrganizationMember(member.id, { status: 'disabled' })
      setMemberNotice(member.status === 'invited' ? '邀请已取消' : '成员已移除')
      await refreshOrganization()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  async function toggleAssignmentActive(item: Assignment, isActive: boolean) {
    setLoading(true)
    setError('')
    try {
      await collectionApi.upsertAssignment({
        phone: item.phone,
        task_id: item.task_id,
        target_date: item.target_date,
        target_seconds: item.target_seconds,
        is_active: isActive,
      })
      if (assignmentEditor?.id === item.id) {
        setAssignmentEditor({ ...assignmentEditor, is_active: isActive })
      }
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  function openCreateDialog() {
    setTaskDialog({ mode: 'create', draft: { ...emptyTask } })
  }

  function openTaskDialog(task: CollectionTask) {
    if (!task.is_active) return
    setTaskDialog({ mode: 'details', taskId: task.id })
  }

  function editDialogTask() {
    if (!dialogTask) return
    setTaskDialog({ mode: 'edit', taskId: dialogTask.id, draft: taskToPayload(dialogTask) })
  }

  function publishDialogTask() {
    if (!dialogTask) return
    setSelectedTaskId(dialogTask.id)
    setTaskDialog({ mode: 'publish', taskId: dialogTask.id })
  }

  function taskPublishCount(taskId: string) {
    return publishCounts[taskId] || 0
  }

  function closeTaskDialog() {
    setTaskDialog({ mode: 'closed' })
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

  function canRemoveOrganizationMember(member: OrganizationMember) {
    if (!canManageMembers || member.role_code === 'owner') return false
    return membershipRole === 'owner' || member.role_code === 'member' || member.status === 'invited'
  }

  function dragTask(event: DragEvent<HTMLButtonElement>, task: CollectionTask) {
    if (!task.is_active) {
      event.preventDefault()
      return
    }
    setDraggingTaskId(task.id)
    setTrashHover(false)
    setTrashReady(false)
    clearTrashReadyTimer()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', task.id)
  }

  function armTrashDrop() {
    if (!draggingTaskId) return
    setTrashHover(true)
    if (trashReadyTimer.current !== null) return
    trashReadyTimer.current = window.setTimeout(() => {
      setTrashReady(true)
      trashReadyTimer.current = null
    }, 650)
  }

  function disarmTrashDrop() {
    clearTrashReadyTimer()
    setTrashHover(false)
    setTrashReady(false)
  }

  function leaveTrashDrop(event: DragEvent<HTMLElement>) {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) {
      return
    }
    disarmTrashDrop()
  }

  function dropTaskForDelete(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    const taskId = event.dataTransfer.getData('text/plain')
    const task = trashReady ? tasks.find((item) => item.id === taskId) : null
    resetTrashDragState()
    if (task) {
      setTaskDialog({ mode: 'delete', taskId: task.id })
    }
  }

  function renderTaskFields(value: TaskPayload, update: (next: TaskPayload) => void) {
    return (
      <>
        <label>
          <span>任务描述</span>
          <textarea
            className="collection-input collection-textarea"
            value={value.task_prompt}
            onChange={(event) => update({ ...value, task_prompt: event.target.value })}
            required
          />
        </label>
        <div className="collection-form-grid">
          <label>
            <span>Episodes</span>
            <input className="collection-input" type="number" min={1} value={value.num_episodes} onChange={(event) => update({ ...value, num_episodes: Number(event.target.value) })} />
          </label>
          <label>
            <span>FPS</span>
            <input className="collection-input" type="number" min={1} value={value.fps} onChange={(event) => update({ ...value, fps: Number(event.target.value) })} />
          </label>
          <label>
            <span>录制秒</span>
            <input className="collection-input" type="number" min={1} value={value.episode_time_s} onChange={(event) => update({ ...value, episode_time_s: Number(event.target.value) })} />
          </label>
          <label>
            <span>Reset 秒</span>
            <input className="collection-input" type="number" min={0} value={value.reset_time_s} onChange={(event) => update({ ...value, reset_time_s: Number(event.target.value) })} />
          </label>
          <label>
            <span>Dataset prefix</span>
            <input className="collection-input" value={value.dataset_prefix} onChange={(event) => update({ ...value, dataset_prefix: event.target.value })} required />
          </label>
          <label className="collection-checkbox">
            <input
              type="checkbox"
              checked={value.use_cameras ?? true}
              onChange={(event) => update({ ...value, use_cameras: event.target.checked })}
            />
            <span>使用相机</span>
          </label>
        </div>
      </>
    )
  }

  function renderPhoneInputs() {
    return (
      <div className="collection-field">
        <span>成员</span>
        <div className="collection-phone-list">
          {phoneRows.map((phone, index) => (
            <div className="collection-phone-row" key={index}>
              <OrganizationMemberPicker
                value={phone}
                resolver={memberInputResolver}
                onChange={(value) => updatePhoneRow(index, value)}
                placeholder="输入手机号或昵称"
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
      </div>
    )
  }

  if (isChecking) {
    return <div className="collection-page"><div className="collection-empty">Checking account...</div></div>
  }

  if (!isLoggedIn || !canManageCollection(user)) {
    return <Navigate to="/collection/control" replace />
  }

  return (
    <div className="collection-page">
      <div className="collection-toolbar collection-toolbar--actions-only">
        <div className="collection-toolbar__actions">
          <div className="collection-mode-tabs" role="tablist" aria-label="采集管理视图">
            <button
              type="button"
              className={view === 'publish' ? 'collection-mode-tab collection-mode-tab--active' : 'collection-mode-tab'}
              onClick={() => setView('publish')}
            >
              任务发布
            </button>
            <button
              type="button"
              className={view === 'progress' ? 'collection-mode-tab collection-mode-tab--active' : 'collection-mode-tab'}
              onClick={() => setView('progress')}
            >
              任务进度
            </button>
            <button
              type="button"
              className={view === 'members' ? 'collection-mode-tab collection-mode-tab--active' : 'collection-mode-tab'}
              onClick={() => setView('members')}
            >
              成员管理
            </button>
          </div>
        </div>
      </div>

      {error && <div className="collection-error">{error}</div>}
      {memberNotice && view === 'members' && <div className="collection-warning">{memberNotice}</div>}

      {view === 'publish' && (
        <div className="collection-publish-stage">
          <section className="collection-task-pool">
            <div className="collection-pool-head">
              <div>
                <h3>任务池</h3>
                <span>{activeTasks.length} 个任务</span>
              </div>
              <button type="button" className="collection-link-button collection-link-button--primary" onClick={openCreateDialog}>
                新建任务
              </button>
            </div>

            <div className="collection-task-bubbles" aria-label="任务池">
              {activeTasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  draggable={task.is_active}
                  onDragStart={(event) => dragTask(event, task)}
                  onDragEnd={resetTrashDragState}
                  onClick={() => openTaskDialog(task)}
                  disabled={!task.is_active}
                  className={cn(
                    'collection-task-bubble',
                    selectedTaskId === task.id && 'collection-task-bubble--selected',
                    !task.is_active && 'collection-task-bubble--inactive',
                  )}
                >
                  <div className="collection-task-bubble__top">
                    <strong>{task.task_prompt}</strong>
                    <span>{taskPublishCount(task.id)} 次发布</span>
                  </div>
                  <div className="collection-task-bubble__metrics">
                    <span>{task.num_episodes} eps · {task.fps} fps</span>
                    <small>{task.episode_time_s}s record · {task.reset_time_s}s reset</small>
                  </div>
                </button>
              ))}
              {activeTasks.length === 0 && (
                <div className="collection-empty collection-empty--compact">先创建一个任务</div>
              )}
            </div>
          </section>
        </div>
      )}

      {draggingTaskId && (
        <section
          className={cn(
            'collection-trash-flyout',
            trashHover && 'collection-trash-flyout--hover',
            trashReady && 'collection-trash-flyout--ready',
          )}
          onDragEnter={(event) => {
            event.preventDefault()
            armTrashDrop()
          }}
          onDragOver={(event) => {
            event.preventDefault()
            event.dataTransfer.dropEffect = trashReady ? 'move' : 'none'
            armTrashDrop()
          }}
          onDragLeave={leaveTrashDrop}
          onDrop={dropTaskForDelete}
        >
          <strong>{trashReady ? '松开删除' : '删除任务'}</strong>
          <span>{trashReady ? '会先让你确认' : '拖到这里停留片刻'}</span>
        </section>
      )}

      {view === 'progress' && (
        <section className="collection-panel collection-panel--wide">
        <div className="collection-panel__head collection-panel__head--progress">
          <div>
            <h3>{allDates ? '全部进度' : `${targetDate} 进度`}</h3>
            <span>{progress.length} 个分配 · {formatHours(totalCompletedSeconds)} / {formatHours(totalTargetSeconds)}</span>
          </div>
          <div className="collection-progress-filters">
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
        <div className="collection-progress-list">
          {progress.map((item) => {
            const pct = assignmentProgressPct(item)
            const editing = assignmentEditor?.id === item.id
            return (
              <div
                className={editing ? 'collection-progress-item collection-progress-item--editing' : 'collection-progress-item'}
                key={item.id}
              >
                <div className="collection-progress-row">
                  <div>
                    <strong>{item.task_params.task}</strong>
                    <span>{item.target_date} · {item.phone}{item.user_nickname ? ` · ${item.user_nickname}` : ''}</span>
                  </div>
                  <div className="collection-progress-row__bar"><span style={{ width: `${pct}%` }} /></div>
                  <div className="collection-progress-row__actions">
                    <button
                      type="button"
                      className={item.is_active ? 'collection-assignment-switch collection-assignment-switch--on' : 'collection-assignment-switch'}
                      aria-pressed={item.is_active}
                      disabled={loading}
                      onClick={() => toggleAssignmentActive(item, !item.is_active)}
                    >
                      <span><i /></span>
                      <strong>{item.is_active ? '分配' : '停止'}</strong>
                    </button>
                    <div className="collection-progress-row__value">
                      {formatHours(item.completed_seconds)} / {formatHours(item.target_seconds)}
                    </div>
                    <button
                      type="button"
                      className="collection-link-button"
                      onClick={() => setAssignmentEditor(editing ? null : assignmentToEditState(item))}
                    >
                      {editing ? '收起' : '编辑'}
                    </button>
                  </div>
                </div>

                {editing && assignmentEditor && (
                  <form className="collection-progress-edit" onSubmit={updateAssignment}>
                    <label>
                      <span>任务</span>
                      <select
                        className="collection-input"
                        value={assignmentEditor.task_id}
                        onChange={(event) => setAssignmentEditor({ ...assignmentEditor, task_id: event.target.value })}
                        required
                      >
                        {tasks.map((task) => (
                          <option key={task.id} value={task.id}>{task.task_prompt}</option>
                        ))}
                      </select>
                    </label>
                    <div className="collection-progress-edit__grid collection-progress-edit__grid--assignment">
                      <label>
                        <span>日期</span>
                        <input className="collection-input" type="date" value={assignmentEditor.target_date} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, target_date: event.target.value })} required />
                      </label>
                      <label>
                        <span>目标小时</span>
                        <input className="collection-input" type="number" min={0.1} step={0.1} value={assignmentEditor.target_hours} onChange={(event) => setAssignmentEditor({ ...assignmentEditor, target_hours: event.target.value })} required />
                      </label>
                    </div>
                    <div className="collection-progress-edit__actions">
                      <button
                        type="button"
                        className="collection-link-button"
                        onClick={() => setAssignmentEditor(null)}
                      >
                        取消
                      </button>
                      <ActionButton type="submit" disabled={loading || !assignmentEditor.task_id}>确定</ActionButton>
                    </div>
                  </form>
                )}
              </div>
            )
          })}
          {progress.length === 0 && <div className="collection-empty collection-empty--compact">暂无分配</div>}
        </div>
        </section>
      )}

      {view === 'members' && (
        <section className="collection-panel collection-panel--wide collection-members-panel">
          <div className="collection-members-hero">
            <div>
              <span className="collection-members-hero__eyebrow">组织成员</span>
              <h3>{organization?.name || '当前组织'}</h3>
              <p>{visibleOrganizationMembers.length} 个成员</p>
            </div>
            <span className={cn('collection-role-pill', `collection-role-pill--${membershipRole || 'member'}`)}>
              当前角色 {membershipRoleLabel(membershipRole || 'member')}
            </span>
          </div>

          <form className="collection-member-invite" onSubmit={inviteMember}>
            <div className="collection-field">
              <span>成员</span>
              <OrganizationMemberPicker
                value={memberPhone}
                resolver={memberInputResolver}
                onChange={setMemberPhone}
                placeholder="输入手机号或昵称"
                required
              />
            </div>
            <div className="collection-field">
              <span>角色</span>
              {canChooseInviteRole ? (
                <select
                  className="collection-input"
                  value={effectiveInviteRole}
                  onChange={(event) => {
                    if (isInviteRole(event.target.value)) setMemberRole(event.target.value)
                  }}
                >
                  {inviteRoleOptions.map((role) => (
                    <option key={role} value={role}>{membershipRoleLabel(role)}</option>
                  ))}
                </select>
              ) : (
                <div className="collection-member-invite__fixed-role">
                  {membershipRoleLabel('member')}
                </div>
              )}
            </div>
            <ActionButton
              className="collection-member-invite__submit"
              type="submit"
              disabled={loading || !canInviteMember}
            >
              邀请成员
            </ActionButton>
          </form>

          <div className="collection-member-list">
            {visibleOrganizationMembers.map((member) => {
              const removable = canRemoveOrganizationMember(member)
              return (
                <article className="collection-member-card" key={member.id}>
                  <div className="collection-member-card__identity">
                    <span className="collection-member-card__avatar">
                      {(member.nickname || member.phone).slice(0, 1)}
                    </span>
                    <div>
                      <strong>{member.nickname || '未设置昵称'}</strong>
                      <span>{maskPhone(member.phone)}</span>
                    </div>
                  </div>
                  <div className="collection-member-card__meta">
                    {removable && (
                      <button
                        type="button"
                        className="collection-member-card__remove"
                        disabled={loading}
                        title={member.status === 'invited' ? '取消邀请' : '移除成员'}
                        aria-label={member.status === 'invited' ? '取消邀请' : '移除成员'}
                        onClick={() => void removeMember(member)}
                      >
                        ×
                      </button>
                    )}
                    <span className={cn('collection-role-pill', `collection-role-pill--${member.role_code}`)}>
                      {membershipRoleLabel(member.role_code)}
                    </span>
                    <span className={cn('collection-status-pill', `collection-status-pill--${member.status}`)}>
                      {member.status}
                    </span>
                  </div>
                </article>
              )
            })}
            {!organization && <div className="collection-empty collection-empty--compact">正在读取组织成员</div>}
            {organization && visibleOrganizationMembers.length === 0 && <div className="collection-empty collection-empty--compact">暂无成员</div>}
          </div>
        </section>
      )}

      {taskDialogOpen && (
        <div
          className="collection-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeTaskDialog()
          }}
        >
          <section className="collection-modal" role="dialog" aria-modal="true" aria-labelledby="collection-task-dialog-title">
            <div className="collection-modal__head">
              <div>
                <h3 id="collection-task-dialog-title">
                  {taskDialog.mode === 'create' ? '创建新任务' : taskDialog.mode === 'edit' ? '编辑任务' : taskDialog.mode === 'publish' ? '发布任务' : '任务详情'}
                </h3>
                <span>{taskDialog.mode === 'create' ? '创建后自动进入任务池' : '任务池里的任务可以编辑参数，也可以直接发布'}</span>
              </div>
              <button type="button" className="collection-link-button" onClick={closeTaskDialog}>关闭</button>
            </div>

            {taskDialog.mode === 'create' && (
              <form className="collection-modal-form" onSubmit={createTask}>
                {renderTaskFields(taskDialog.draft, (draft) => setTaskDialog({ ...taskDialog, draft }))}
                <div className="collection-modal__actions">
                  <ActionButton type="submit" disabled={loading}>创建</ActionButton>
                </div>
              </form>
            )}

            {taskDialog.mode === 'details' && dialogTask && (
              <div className="collection-task-dialog">
                <div className="collection-task-dialog-card">
                  <strong>{dialogTask.task_prompt}</strong>
                  <span>{dialogTask.num_episodes} eps · {dialogTask.fps} fps · {dialogTask.episode_time_s}s record · {dialogTask.reset_time_s}s reset</span>
                  <span>{taskPublishCount(dialogTask.id)} 次发布</span>
                  <small>Dataset prefix: {dialogTask.dataset_prefix}</small>
                </div>
                <div className="collection-modal__actions">
                  <button type="button" className="collection-link-button" onClick={editDialogTask}>编辑</button>
                  <ActionButton type="button" onClick={publishDialogTask}>发布</ActionButton>
                </div>
              </div>
            )}

            {taskDialog.mode === 'edit' && dialogTask && (
              <form className="collection-modal-form" onSubmit={updateTask}>
                {renderTaskFields(taskDialog.draft, (draft) => setTaskDialog({ ...taskDialog, draft }))}
                <div className="collection-modal__actions">
                  <ActionButton type="submit" disabled={loading}>确定</ActionButton>
                </div>
              </form>
            )}

            {taskDialog.mode === 'publish' && dialogTask && (
              <form className="collection-modal-form" onSubmit={assignTask}>
                <div className="collection-drop-target">
                  <strong>{dialogTask.task_prompt}</strong>
                  <span>{dialogTask.num_episodes} eps · {dialogTask.fps} fps · {dialogTask.episode_time_s}s</span>
                  <span>{taskPublishCount(dialogTask.id)} 次发布</span>
                </div>
                {renderPhoneInputs()}
                <div className="collection-form-grid">
                  <label>
                    <span>指定日期</span>
                    <input className="collection-input" type="date" value={targetDate} onChange={(event) => setTargetDate(event.target.value)} />
                  </label>
                  <label>
                    <span>目标小时</span>
                    <input className="collection-input" type="number" min={0.1} step={0.1} value={targetHours} onChange={(event) => setTargetHours(event.target.value)} />
                  </label>
                </div>
                <div className="collection-modal__actions">
                  <button type="button" className="collection-link-button" onClick={() => setTaskDialog({ mode: 'details', taskId: taskDialog.taskId })}>返回</button>
                  <ActionButton type="submit" disabled={loading || !canPublishToMembers}>发布</ActionButton>
                </div>
              </form>
            )}
          </section>
        </div>
      )}

      {taskDialog.mode === 'delete' && dialogTask && (
        <div
          className="collection-modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeTaskDialog()
          }}
        >
          <section className="collection-modal collection-modal--narrow" role="dialog" aria-modal="true" aria-labelledby="collection-delete-dialog-title">
            <div className="collection-modal__head">
              <div>
                <h3 id="collection-delete-dialog-title">删除任务</h3>
                <span>确认后这个任务会从任务池删除</span>
              </div>
              <button type="button" className="collection-link-button" onClick={closeTaskDialog}>关闭</button>
            </div>
            <div className="collection-task-dialog-card">
              <strong>{dialogTask.task_prompt}</strong>
              <span>{dialogTask.num_episodes} eps · {dialogTask.fps} fps · {dialogTask.episode_time_s}s</span>
            </div>
            <div className="collection-modal__actions">
              <ActionButton type="button" variant="danger" disabled={loading} onClick={deleteTask}>确认删除</ActionButton>
            </div>
          </section>
        </div>
      )}
    </div>
  )
}
