import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataJobStore } from '@/domains/data/store/jobStore'

interface LifecycleState {
  running: boolean
  error: string
  startClean: (datasetIds: string[]) => Promise<void>
  passReview: (datasetId: string) => Promise<void>
}

export const useDataLifecycleStore = create<LifecycleState>(() => ({
  running: false,
  error: '',
  startClean: async (datasetIds) => {
    const job = await dataApi.startCleanRun({ dataset_ids: datasetIds, force: true })
    useDataJobStore.getState().attach(job)
  },
  passReview: async (datasetId) => {
    await dataApi.updateDatasetGate(datasetId, 'review', { status: 'passed', message: 'Manual review passed' })
  },
}))
