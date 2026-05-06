import { useEffect, useMemo } from 'react'
import { useI18n } from '@/i18n'
import { SectionIntro } from '@/shared/ui'
import ActionBar from '../components/ActionBar'
import DatasetTable from '../components/DatasetTable'
import FilterBar from '../components/FilterBar'
import ProgressPanel from '../components/ProgressPanel'
import SummaryCards from '../components/SummaryCards'
import {
  selectIsJobActive,
  useDatasetRepairStore,
} from '../store/useDatasetRepairStore'
import type { DatasetJobItem } from '../types'
import '../styles.css'

export default function DatasetRepairPage() {
  const { t } = useI18n()
  const filters = useDatasetRepairStore((state) => state.filters)
  const datasets = useDatasetRepairStore((state) => state.datasets)
  const effectiveRoot = useDatasetRepairStore((state) => state.effectiveRoot)
  const loading = useDatasetRepairStore((state) => state.loading)
  const acting = useDatasetRepairStore((state) => state.acting)
  const error = useDatasetRepairStore((state) => state.error)
  const currentJob = useDatasetRepairStore((state) => state.currentJob)
  const isJobActive = useDatasetRepairStore(selectIsJobActive)

  const setFilter = useDatasetRepairStore((state) => state.setFilter)
  const loadDatasets = useDatasetRepairStore((state) => state.loadDatasets)
  const refreshCurrentJob = useDatasetRepairStore((state) => state.refreshCurrentJob)
  const startDiagnosis = useDatasetRepairStore((state) => state.startDiagnosis)
  const startRepairJob = useDatasetRepairStore((state) => state.startRepairJob)
  const cancelCurrent = useDatasetRepairStore((state) => state.cancelCurrent)
  const teardown = useDatasetRepairStore((state) => state.teardown)
  const resetError = useDatasetRepairStore((state) => state.resetError)

  useEffect(() => {
    void loadDatasets()
    void refreshCurrentJob()
    return () => {
      teardown()
    }
  }, [loadDatasets, refreshCurrentJob, teardown])

  const itemsByDatasetId = useMemo<Record<string, DatasetJobItem>>(() => {
    if (!currentJob) return {}
    const map: Record<string, DatasetJobItem> = {}
    for (const item of currentJob.items) {
      map[item.dataset_id] = item
    }
    return map
  }, [currentJob])

  const filtersDisabled = isJobActive
  const handleDiagnose = () => {
    void startDiagnosis()
  }
  const handleRepair = () => {
    void startRepairJob()
  }
  const handleCancel = () => {
    void cancelCurrent()
  }

  return (
    <div className="page-enter flex flex-col gap-6 p-4 md:p-6">
      <SectionIntro
        eyebrow={t('pipelineNav')}
        title={t('datasetRepair')}
        description="诊断并修复 datasets/local 下的录制数据集，原始数据不会被修改"
      />

      <FilterBar
        filters={filters}
        effectiveRoot={effectiveRoot}
        loading={loading}
        disabled={filtersDisabled}
        onChange={setFilter}
        onScan={() => void loadDatasets()}
      />

      <SummaryCards datasets={datasets} />

      <ActionBar
        hasDatasets={datasets.length > 0}
        isJobActive={isJobActive}
        acting={acting}
        onDiagnose={handleDiagnose}
        onRepair={handleRepair}
        onCancel={handleCancel}
      />

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-[color:rgba(204,68,68,0.2)] bg-[rgba(204,68,68,0.06)] px-4 py-3 text-sm text-[color:#b13838]">
          <span>{error}</span>
          <button
            type="button"
            onClick={resetError}
            className="text-xs font-semibold uppercase tracking-[0.18em] text-[color:#b13838] hover:underline"
          >
            清除
          </button>
        </div>
      )}

      <DatasetTable datasets={datasets} itemsByDatasetId={itemsByDatasetId} />

      {currentJob && <ProgressPanel job={currentJob} errorBanner={error || null} />}
    </div>
  )
}
