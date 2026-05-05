const ACCESS_KEY = 'evo_access_token'

export interface TaskParams {
  task: string
  num_episodes: number
  fps: number
  episode_time_s: number
  reset_time_s: number
  use_cameras: boolean
}

export interface CollectionTask {
  id: string
  org_id: string
  name: string
  description: string | null
  task_prompt: string
  num_episodes: number
  fps: number
  episode_time_s: number
  reset_time_s: number
  use_cameras: boolean
  dataset_prefix: string
  is_active: boolean
  created_by_id: string | null
  created_at: string
  updated_at: string | null
}

export interface Assignment {
  id: string
  org_id: string
  user_id: string | null
  phone: string
  task_id: string
  task_name: string
  target_date: string
  target_seconds: number
  completed_seconds: number
  active_run_id: string | null
  is_active: boolean
  task_params: TaskParams
  user_nickname?: string | null
}

export interface CollectionStatus {
  active_run: {
    run_id: string
    assignment_id: string
    dataset_name: string
    task_params: TaskParams
  } | null
  pending_finish_count: number
  session: {
    state: string
    record_phase: string
    saved_episodes: number
    target_episodes: number
    total_frames: number
    elapsed_seconds: number
    dataset: string | null
    error: string
  }
}

export interface CollectionToday {
  today: string
  timezone: string
}

export interface RunStartResponse {
  status: string
  dataset_name: string
  task_params: TaskParams
  run: {
    id: string
    dataset_name: string
    status: string
    duration_seconds: number
  }
}

export interface RunStopResponse {
  status: 'finished' | 'failed' | 'pending_cloud_finish' | 'idle'
  pending_finish_count: number
  detail?: string
  local_stop_error?: string | null
  run?: {
    id: string
    status: string
    duration_seconds: number
  } | null
}

export interface TaskPayload {
  name?: string
  description?: string
  task_prompt: string
  num_episodes?: number
  fps?: number
  episode_time_s?: number
  reset_time_s?: number
  use_cameras?: boolean
  dataset_prefix?: string
  is_active?: boolean
}

export interface AssignmentPayload {
  phone: string
  task_id: string
  target_date: string
  target_seconds: number
  is_active: boolean
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem(ACCESS_KEY)
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function collectionRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/collection${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  })
  let body: any = null
  try {
    body = await response.json()
  } catch {
    body = null
  }
  if (!response.ok) {
    throw new Error(body?.detail || body?.message || `HTTP ${response.status}`)
  }
  return body as T
}

function postJson<T>(path: string, body?: unknown): Promise<T> {
  return collectionRequest<T>(path, {
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  })
}

function patchJson<T>(path: string, body: unknown): Promise<T> {
  return collectionRequest<T>(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
  })
}

function deleteJson<T>(path: string): Promise<T> {
  return collectionRequest<T>(path, {
    method: 'DELETE',
  })
}

export const collectionApi = {
  getToday: (): Promise<CollectionToday> => collectionRequest('/today'),
  getStatus: (): Promise<CollectionStatus> => collectionRequest('/status'),
  getAssignments: (targetDate?: string): Promise<Assignment[]> => {
    const query = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : ''
    return collectionRequest(`/assignments${query}`)
  },
  startRun: (assignmentId: string): Promise<RunStartResponse> =>
    postJson('/runs/start', { assignment_id: assignmentId }),
  stopRun: (): Promise<RunStopResponse> => postJson('/runs/stop'),
  retryPending: (): Promise<{ status: string; synced: number; pending_finish_count: number }> =>
    postJson('/pending/retry'),
  listTasks: (): Promise<CollectionTask[]> => collectionRequest('/publish/tasks?include_inactive=true'),
  createTask: (payload: TaskPayload): Promise<CollectionTask> => postJson('/publish/tasks', payload),
  updateTask: (taskId: string, payload: Partial<TaskPayload>): Promise<CollectionTask> =>
    patchJson(`/publish/tasks/${taskId}`, payload),
  deleteTask: (taskId: string): Promise<void> => deleteJson(`/publish/tasks/${taskId}`),
  upsertAssignment: (payload: AssignmentPayload): Promise<Assignment> =>
    postJson('/publish/assignments', payload),
  getProgress: (targetDate?: string): Promise<Assignment[]> => {
    const query = targetDate ? `?target_date=${encodeURIComponent(targetDate)}` : ''
    return collectionRequest(`/publish/progress${query}`)
  },
}
