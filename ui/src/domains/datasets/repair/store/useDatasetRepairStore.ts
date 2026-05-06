import { create, type StoreApi } from 'zustand'
import {
  JobConflictError,
  cancelJob,
  getCurrentJob,
  listDatasets,
  startDiagnose,
  startRepair,
} from '../lib/api'
import { applyJobEvent } from '../lib/reducer'
import { subscribeJobEvents } from '../lib/sse'
import {
  TERMINAL_PHASES,
  type DatasetRepairDataset,
  type DatasetRepairFilters,
  type RepairJobState,
} from '../types'

const DEFAULT_FILTERS: DatasetRepairFilters = {
  root: '',
  date_from: '',
  date_to: '',
  task: '',
  tag: 'all',
}

interface LoadOptions {
  keepError?: boolean
}

interface DatasetRepairStore {
  filters: DatasetRepairFilters
  datasets: DatasetRepairDataset[]
  effectiveRoot: string
  loading: boolean
  acting: boolean
  error: string
  currentJob: RepairJobState | null
  unsubscribe: (() => void) | null

  setFilter: <K extends keyof DatasetRepairFilters>(
    key: K,
    value: DatasetRepairFilters[K],
  ) => void
  resetError: () => void
  loadDatasets: (options?: LoadOptions) => Promise<void>
  refreshCurrentJob: () => Promise<void>
  startDiagnosis: () => Promise<void>
  startRepairJob: () => Promise<void>
  subscribeToJob: (jobId: string) => void
  cancelCurrent: () => Promise<void>
  teardown: () => void
}

function isJobActive(job: RepairJobState | null): boolean {
  return job !== null && !TERMINAL_PHASES.has(job.phase)
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

type StoreSet = StoreApi<DatasetRepairStore>['setState']
type StoreGet = StoreApi<DatasetRepairStore>['getState']

async function runJob(
  start: () => Promise<RepairJobState>,
  failureText: string,
  set: StoreSet,
  get: StoreGet,
): Promise<void> {
  if (get().acting) return
  set({ acting: true, error: '' })
  try {
    const job = await start()
    set({ currentJob: job })
    get().subscribeToJob(job.job_id)
  } catch (error) {
    if (error instanceof JobConflictError) {
      // Backend rejected start because another job is running. Adopt that
      // job's state so the user sees the running progress.
      set({ currentJob: error.job, error: error.message })
      if (isJobActive(error.job)) get().subscribeToJob(error.job.job_id)
    } else {
      set({ error: errorMessage(error, failureText) })
    }
  } finally {
    set({ acting: false })
  }
}

export const useDatasetRepairStore = create<DatasetRepairStore>((set, get) => ({
  filters: { ...DEFAULT_FILTERS },
  datasets: [],
  effectiveRoot: '',
  loading: false,
  acting: false,
  error: '',
  currentJob: null,
  unsubscribe: null,

  setFilter: (key, value) => {
    set((state) => ({ filters: { ...state.filters, [key]: value } }))
  },

  resetError: () => set({ error: '' }),

  loadDatasets: async (options) => {
    set(options?.keepError ? { loading: true } : { loading: true, error: '' })
    try {
      const response = await listDatasets(get().filters)
      set({ datasets: response.datasets, effectiveRoot: response.root })
    } catch (error) {
      set({ error: errorMessage(error, '加载数据集失败') })
    } finally {
      set({ loading: false })
    }
  },

  refreshCurrentJob: async () => {
    try {
      const { job } = await getCurrentJob()
      set({ currentJob: job })
      if (job && isJobActive(job)) {
        get().subscribeToJob(job.job_id)
      }
    } catch (error) {
      set({ error: errorMessage(error, '获取任务状态失败') })
    }
  },

  startDiagnosis: () =>
    runJob(() => startDiagnose(get().filters), '启动诊断失败', set, get),

  startRepairJob: () =>
    runJob(() => startRepair(get().filters), '启动修复失败', set, get),

  subscribeToJob: (jobId) => {
    const previous = get().unsubscribe
    if (previous) previous()
    const close = subscribeJobEvents(
      jobId,
      (event) => {
        set((state) => ({ currentJob: applyJobEvent(state.currentJob, event) }))
        if (event.type === 'job-error' && event.data.error) {
          set({ error: event.data.error })
        }
      },
      () => {
        set({ unsubscribe: null })
        // Refresh dataset list so tags/repairable reflect the result; preserve
        // any error from the SSE job-error event so the user can see what failed.
        void get().loadDatasets({ keepError: true })
      },
    )
    set({ unsubscribe: close })
  },

  cancelCurrent: async () => {
    if (get().acting) return
    const job = get().currentJob
    if (!job) return
    set({ acting: true, error: '' })
    try {
      const next = await cancelJob(job.job_id)
      set({ currentJob: next })
    } catch (error) {
      set({ error: errorMessage(error, '取消失败') })
    } finally {
      set({ acting: false })
    }
  },

  teardown: () => {
    const close = get().unsubscribe
    if (close) close()
    set({ unsubscribe: null })
  },
}))

export function selectIsJobActive(state: DatasetRepairStore): boolean {
  return isJobActive(state.currentJob)
}
