import { create } from 'zustand'
import { dataApi } from '@/domains/data/api/dataApi'
import type { Dataset, DatasetPackage } from '@/domains/data/model/types'

interface LibraryState {
  datasets: Dataset[]
  packages: DatasetPackage[]
  selectedDatasetIds: string[]
  loading: boolean
  error: string
  load: () => Promise<void>
  toggleDataset: (datasetId: string) => void
  createPackage: (packageId: string) => Promise<DatasetPackage>
  importDataset: (datasetId: string) => Promise<void>
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
    await dataApi.importDataset({ dataset_id: datasetId, include_videos: true, force: false })
  },
}))
