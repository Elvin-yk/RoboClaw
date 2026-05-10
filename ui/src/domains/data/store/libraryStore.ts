import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import type { Dataset, DatasetPackage } from '@/domains/data/model/types'

interface LibraryState {
  datasets: Dataset[]
  packages: DatasetPackage[]
  selectedDatasetIds: string[]
  loading: boolean
  error: string
  load: () => Promise<void>
  toggleDataset: (datasetId: string) => void
  setDatasetSelection: (datasetIds: string[], selected: boolean) => void
  clearSelection: () => void
  createPackage: (packageId: string) => Promise<DatasetPackage>
  importDataset: (datasetId: string) => Promise<void>
  deleteDataset: (datasetId: string) => Promise<void>
  deletePackage: (packageId: string) => Promise<void>
}

export const useDataLibraryStore = create<LibraryState>((set, get) => ({
  datasets: [],
  packages: [],
  selectedDatasetIds: [],
  loading: false,
  error: '',
  load: async () => {
    set({ loading: true, error: '' })
    try {
      const [datasets, packages] = await Promise.all([dataApi.listDatasets(), dataApi.listPackages()])
      set({ datasets, packages, loading: false })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error), loading: false })
    }
  },
  toggleDataset: (datasetId) => {
    set((state) => ({
      selectedDatasetIds: state.selectedDatasetIds.includes(datasetId)
        ? state.selectedDatasetIds.filter((id) => id !== datasetId)
        : [...state.selectedDatasetIds, datasetId],
    }))
  },
  setDatasetSelection: (datasetIds, selected) => {
    const targetIds = new Set(datasetIds)
    set((state) => {
      if (!selected) {
        return {
          selectedDatasetIds: state.selectedDatasetIds.filter((id) => !targetIds.has(id)),
        }
      }
      const nextIds = new Set(state.selectedDatasetIds)
      targetIds.forEach((id) => nextIds.add(id))
      return { selectedDatasetIds: [...nextIds] }
    })
  },
  clearSelection: () => set({ selectedDatasetIds: [] }),
  createPackage: async (packageId) => {
    const created = await dataApi.createPackage({
      package_id: packageId,
      dataset_ids: get().selectedDatasetIds,
      force: false,
    })
    await get().load()
    return created
  },
  importDataset: async (datasetId) => {
    const job = await dataApi.importDataset({ dataset_id: datasetId, include_videos: true, force: false })
    useDataJobStore.getState().attach(job)
  },
  deleteDataset: async (datasetId) => {
    await dataApi.deleteDataset(datasetId)
    await get().load()
  },
  deletePackage: async (packageId) => {
    await dataApi.deletePackage(packageId)
    await get().load()
  },
}))
