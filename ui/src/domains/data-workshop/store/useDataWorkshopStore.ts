import { create } from 'zustand'
import { api, postJson } from '@/shared/api/client'
import type { DatasetAssembly, GateKey, GateStatus, WorkshopDataset } from '../types'

interface DataWorkshopStore {
  datasets: WorkshopDataset[]
  assemblies: DatasetAssembly[]
  selectedDataset: WorkshopDataset | null
  loading: boolean
  acting: boolean
  error: string
  load: () => Promise<void>
  selectDataset: (datasetId: string) => Promise<void>
  diagnoseDataset: (datasetId: string) => Promise<void>
  repairDataset: (datasetId: string) => Promise<void>
  updateGate: (
    datasetId: string,
    gateKey: GateKey,
    payload: {
      status: GateStatus
      message?: string
      details?: Record<string, unknown>
      groups?: string[]
      batch?: string
      notes?: string
    },
  ) => Promise<void>
  promoteDataset: (datasetId: string) => Promise<void>
  createAssembly: (
    name: string,
    datasetIds: string[],
    groups: Record<string, string[]>,
  ) => Promise<DatasetAssembly>
  queueUpload: (assemblyId: string) => Promise<void>
  _mutateDataset: (
    datasetId: string,
    url: string,
    payload: Record<string, unknown>,
  ) => Promise<void>
}

export const useDataWorkshopStore = create<DataWorkshopStore>((set, get) => ({
  datasets: [],
  assemblies: [],
  selectedDataset: null,
  loading: false,
  acting: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' })
    try {
      const [datasets, assemblies] = await Promise.all([
        api<WorkshopDataset[]>('/api/data-workshop/datasets'),
        api<DatasetAssembly[]>('/api/data-workshop/assemblies'),
      ])
      const selected = get().selectedDataset
      set({
        datasets,
        assemblies,
        selectedDataset: selected
          ? datasets.find((dataset) => dataset.id === selected.id) ?? null
          : null,
      })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load data workshop' })
    } finally {
      set({ loading: false })
    }
  },

  selectDataset: async (datasetId) => {
    set({ acting: true, error: '' })
    try {
      const dataset = await api<WorkshopDataset>(
        `/api/data-workshop/datasets/${datasetId}`,
      )
      set({ selectedDataset: dataset })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to load dataset' })
    } finally {
      set({ acting: false })
    }
  },

  diagnoseDataset: async (datasetId) => {
    await get()._mutateDataset(datasetId, `/api/data-workshop/datasets/${datasetId}/diagnose`, {})
  },

  repairDataset: async (datasetId) => {
    await get()._mutateDataset(datasetId, `/api/data-workshop/datasets/${datasetId}/repair`, {})
  },

  updateGate: async (datasetId, gateKey, payload) => {
    await get()._mutateDataset(
      datasetId,
      `/api/data-workshop/datasets/${datasetId}/gates/${gateKey}`,
      payload,
    )
  },

  promoteDataset: async (datasetId) => {
    await get()._mutateDataset(
      datasetId,
      `/api/data-workshop/datasets/${datasetId}/promote`,
      { target_stage: 'clean' },
    )
  },

  createAssembly: async (name, datasetIds, groups) => {
    set({ acting: true, error: '' })
    try {
      const assembly = await postJson<DatasetAssembly>('/api/data-workshop/assemblies', {
        name,
        dataset_ids: datasetIds,
        groups,
      })
      await get().load()
      return assembly
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to create assembly' })
      throw error
    } finally {
      set({ acting: false })
    }
  },

  queueUpload: async (assemblyId) => {
    set({ acting: true, error: '' })
    try {
      const assembly = await postJson<DatasetAssembly>(
        `/api/data-workshop/assemblies/${assemblyId}/upload`,
        { target: 'aliyun-oss' },
      )
      set((state) => ({
        assemblies: state.assemblies.map((item) => (item.id === assemblyId ? assembly : item)),
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to queue upload' })
      throw error
    } finally {
      set({ acting: false })
    }
  },

  _mutateDataset: async (datasetId: string, url: string, payload: Record<string, unknown>) => {
    set({ acting: true, error: '' })
    try {
      const dataset = await postJson<WorkshopDataset>(url, payload)
      set((state) => ({
        selectedDataset: dataset,
        datasets: state.datasets.map((item) => (item.id === datasetId ? dataset : item)),
      }))
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Dataset action failed' })
      throw error
    } finally {
      set({ acting: false })
    }
  },
}))
