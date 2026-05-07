import { useEffect, useMemo, useState } from 'react'
import { dataApi } from '@/domains/data/api/dataApi'
import type { DataOverview } from '@/domains/data/model/types'

export default function DataOverviewPage() {
  const [overview, setOverview] = useState<DataOverview | null>(null)

  useEffect(() => {
    void dataApi.overview().then(setOverview)
  }, [])

  const recentDatasets = useMemo(() => (
    [...(overview?.datasets || [])]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 8)
  ), [overview])
  const recentPackages = useMemo(() => (
    [...(overview?.packages || [])]
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 8)
  ), [overview])

  return (
    <section className="data-page">
      <div className="data-page__page-actions">
        <button type="button" onClick={() => void dataApi.overview().then(setOverview)}>刷新</button>
      </div>

      <div className="data-grid data-grid--four">
        <Metric title="Datasets" value={overview?.summary.dataset_count ?? 0} />
        <Metric title="Packages" value={overview?.summary.package_count ?? 0} />
        <Metric title="Clean Datasets" value={overview?.summary.dataset_stage_counts.clean ?? 0} />
        <Metric title="Validated Packages" value={overview?.summary.package_stage_counts.validated ?? 0} />
      </div>

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title"><h2>Dataset 阶段</h2></div>
          <StageBars counts={overview?.summary.dataset_stage_counts || {}} />
        </section>
        <section className="data-panel">
          <div className="data-panel__title"><h2>Package 阶段</h2></div>
          <StageBars counts={overview?.summary.package_stage_counts || {}} />
        </section>
      </div>

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title"><h2>最近 Dataset</h2></div>
          <div className="data-list">
            {recentDatasets.map((dataset) => (
              <div key={dataset.id} className="data-row">
                <span>
                  <strong>{dataset.label}</strong>
                  <small>{dataset.id}</small>
                </span>
                <span>{dataset.stats.total_episodes} episodes</span>
                <span className={`data-badge data-badge--${dataset.lifecycle_stage}`}>{dataset.lifecycle_stage}</span>
              </div>
            ))}
            {!recentDatasets.length && <div className="data-empty">暂无 Dataset</div>}
          </div>
        </section>

        <section className="data-panel">
          <div className="data-panel__title"><h2>最近 DatasetPackage</h2></div>
          <div className="data-list">
            {recentPackages.map((item) => (
              <div key={item.id} className="data-row">
                <span>
                  <strong>{item.label}</strong>
                  <small>{item.dataset_ids.join(', ') || 'empty sources'}</small>
                </span>
                <span>{item.stats.total_episodes} episodes</span>
                <span className={`data-badge data-badge--${item.lifecycle_stage}`}>{item.lifecycle_stage}</span>
              </div>
            ))}
            {!recentPackages.length && <div className="data-empty">暂无 DatasetPackage</div>}
          </div>
        </section>
      </div>
    </section>
  )
}

function Metric({ title, value }: { title: string; value: number }) {
  return (
    <section className="data-panel data-panel--metric">
      <span>{title}</span>
      <strong className="data-metric">{value}</strong>
    </section>
  )
}

function StageBars({ counts }: { counts: Record<string, number> }) {
  const entries = Object.entries(counts)
  const max = Math.max(...entries.map(([, value]) => value), 1)
  if (!entries.length) return <div className="data-empty">暂无状态数据</div>
  return (
    <div className="data-bar-list">
      {entries.map(([stage, value]) => (
        <div key={stage} className="data-stage-row">
          <span>{stage}</span>
          <div className="data-stage-bar"><i style={{ width: `${(value / max) * 100}%` }} /></div>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}
