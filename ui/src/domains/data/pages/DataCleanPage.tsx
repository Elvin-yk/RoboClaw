import { useEffect } from 'react'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useDataLifecycleStore } from '@/domains/data/store/lifecycleStore'

export default function DataCleanPage() {
  const { datasets, selectedDatasetIds, load, toggleDataset } = useDataLibraryStore()
  const { startClean, passReview } = useDataLifecycleStore()
  const { jobs } = useDataJobStore()

  useEffect(() => {
    void load()
  }, [load])

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>数据清洗</h1>
          <p>Dataset 生命周期从 raw 进入 inspect、diagnose、clean、review。</p>
        </div>
        <button type="button" onClick={() => void startClean(selectedDatasetIds)} disabled={selectedDatasetIds.length === 0}>
          开始清洗
        </button>
      </header>

      <section className="data-panel">
        <div className="data-list">
          {datasets.map((dataset) => (
            <div key={dataset.id} className="data-row">
              <input
                type="checkbox"
                checked={selectedDatasetIds.includes(dataset.id)}
                onChange={() => toggleDataset(dataset.id)}
              />
              <span>
                <strong>{dataset.label}</strong>
                <small>{Object.values(dataset.gates).map((gate) => `${gate.key}:${gate.status}`).join('  ')}</small>
              </span>
              <span className={`data-badge data-badge--${dataset.lifecycle_stage}`}>{dataset.lifecycle_stage}</span>
              {dataset.lifecycle_stage === 'needs_review' && (
                <button type="button" onClick={() => void passReview(dataset.id).then(load)}>通过 review</button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="data-panel">
        <div className="data-panel__title"><h2>Jobs</h2></div>
        <div className="data-list">
          {Object.values(jobs).map((job) => (
            <div key={job.job_id} className="data-row">
              <span>
                <strong>{job.kind}</strong>
                <small>{job.job_id} · {job.message}</small>
              </span>
              <span>{job.processed}/{job.total}</span>
              <span className={`data-badge data-badge--${job.phase}`}>{job.phase}</span>
            </div>
          ))}
        </div>
      </section>
    </section>
  )
}
