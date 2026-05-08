import { create } from 'zustand'
import { dataApi, jobEventsUrl } from '@/domains/data/api/dataApi'
import { isTerminalDataJobPhase, type DataJob } from '@/domains/data/model/types'

interface JobState {
  jobs: Record<string, DataJob>
  activeJobId: string | null
  attach: (job: DataJob) => void
  refresh: (jobId: string) => Promise<void>
  cancel: (jobId: string) => Promise<void>
}

const sources = new Map<string, EventSource>()

export const useDataJobStore = create<JobState>((set, get) => ({
  jobs: {},
  activeJobId: null,
  attach: (job) => {
    set((state) => ({ jobs: { ...state.jobs, [job.job_id]: job }, activeJobId: job.job_id }))
    if (sources.has(job.job_id)) return
    const source = new EventSource(jobEventsUrl(job.job_id))
    const handleJob = (event: MessageEvent<string>) => {
      const next = JSON.parse(event.data) as DataJob
      set((state) => ({ jobs: { ...state.jobs, [next.job_id]: next }, activeJobId: next.job_id }))
      if (isTerminalDataJobPhase(next.phase)) {
        source.close()
        sources.delete(next.job_id)
      }
    }
    source.addEventListener('snapshot', handleJob)
    source.addEventListener('complete', handleJob)
    source.addEventListener('error', () => {
      source.close()
      sources.delete(job.job_id)
    })
    source.addEventListener('cancel', handleJob)
    source.addEventListener('item', () => {
      void get().refresh(job.job_id)
    })
    sources.set(job.job_id, source)
  },
  refresh: async (jobId) => {
    const job = await dataApi.job(jobId)
    set((state) => ({ jobs: { ...state.jobs, [job.job_id]: job } }))
  },
  cancel: async (jobId) => {
    const job = await dataApi.cancelJob(jobId)
    set((state) => ({ jobs: { ...state.jobs, [job.job_id]: job } }))
  },
}))
