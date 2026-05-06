import { useEffect, useMemo, useState } from 'react'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'

export default function DataDashboardPage() {
  const { datasets, packages, selectedDatasetIds, loading, error, load, toggleDataset, createPackage } = useDataLibraryStore()
  const { jobs } = useDataJobStore()
  const [packageId, setPackageId] = useState('')
  const cleanDatasets = useMemo(() => datasets.filter((dataset) => dataset.lifecycle_stage === 'clean'), [datasets])
  const jobList = Object.values(jobs)
  const latestJob = jobList.length > 0 ? jobList[jobList.length - 1] : undefined

  useEffect(() => {
    void load()
  }, [load])

  async function submitPackage() {
    if (!packageId.trim()) return
    await createPackage(packageId.trim())
    setPackageId('')
  }

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>数据台</h1>
          <p>本地 Dataset 和已物化 DatasetPackage 的统一入口。</p>
        </div>
        <button type="button" onClick={() => void load()} disabled={loading}>刷新</button>
      </header>

      {error && <div className="data-alert">{error}</div>}
      {latestJob && (
        <div className="data-job-strip">
          <strong>{latestJob.kind}</strong>
          <span>{latestJob.phase}</span>
          <span>{latestJob.processed}/{latestJob.total}</span>
          <span>{latestJob.message}</span>
        </div>
      )}

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title">
            <h2>Datasets</h2>
            <span>{datasets.length}</span>
          </div>
          <div className="data-list">
            {datasets.map((dataset) => (
              <label key={dataset.id} className="data-row">
                <input
                  type="checkbox"
                  checked={selectedDatasetIds.includes(dataset.id)}
                  disabled={dataset.lifecycle_stage !== 'clean'}
                  onChange={() => toggleDataset(dataset.id)}
                />
                <span>
                  <strong>{dataset.label}</strong>
                  <small>{dataset.id}</small>
                </span>
                <span className={`data-badge data-badge--${dataset.lifecycle_stage}`}>{dataset.lifecycle_stage}</span>
              </label>
            ))}
            {!datasets.length && <div className="data-empty">暂无本地 Dataset</div>}
          </div>
        </section>

        <section className="data-panel">
          <div className="data-panel__title">
            <h2>DatasetPackage</h2>
            <span>{packages.length}</span>
          </div>
          <div className="data-inline-form">
            <input value={packageId} onChange={(event) => setPackageId(event.target.value)} placeholder="package id" />
            <button type="button" onClick={() => void submitPackage()} disabled={!packageId.trim() || selectedDatasetIds.length === 0}>
              创建
            </button>
          </div>
          <p className="data-help">只能选择 clean Dataset。包会在本地生成真实目录和 `.data/state.json`。</p>
          <div className="data-list">
            {packages.map((item) => (
              <div key={item.id} className="data-row">
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.dataset_ids.join(', ') || 'empty sources'}</small>
                </span>
                <span className={`data-badge data-badge--${item.lifecycle_stage}`}>{item.lifecycle_stage}</span>
              </div>
            ))}
            {!packages.length && <div className="data-empty">暂无 DatasetPackage</div>}
          </div>
        </section>
      </div>

      {cleanDatasets.length === 0 && <div className="data-alert">当前没有 clean Dataset，先到数据清洗完成生命周期。</div>}
    </section>
  )
}
