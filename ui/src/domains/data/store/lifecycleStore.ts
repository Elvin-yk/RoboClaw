import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataJobStore } from '@/domains/data/store/jobStore'

interface LifecycleState {
  running: boolean
  error: string
  startDiagnosis: (datasetIds: string[]) => Promise<void>
  startAutoClean: (datasetIds: string[], chainId?: string) => Promise<void>
  passReview: (datasetId: string) => Promise<void>
}

export const useDataLifecycleStore = create<LifecycleState>(() => ({
  running: false,
  error: '',
  startDiagnosis: async (datasetIds) => {
    const job = await dataApi.startDiagnosisRun({ dataset_ids: datasetIds })
    useDataJobStore.getState().attach(job)
  },
  startAutoClean: async (datasetIds, chainId = 'default') => {
    const job = await dataApi.startAutoCleanRun({ dataset_ids: datasetIds, chain_id: chainId, force: true })
    useDataJobStore.getState().attach(job)
  },
  passReview: async (datasetId) => {
    await dataApi.updateDatasetGate(datasetId, 'review', { status: 'passed', message: 'Manual review passed' })
  },
}))
