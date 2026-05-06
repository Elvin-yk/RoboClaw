import { useEffect, useState } from 'react'
import { dataApi } from '@/domains/data/api/dataApi'
import type { DataOverview } from '@/domains/data/model/types'

export default function DataOverviewPage() {
  const [overview, setOverview] = useState<DataOverview | null>(null)

  useEffect(() => {
    void dataApi.overview().then(setOverview)
  }, [])

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>数据总览</h1>
          <p>Dataset 和 DatasetPackage 生命周期状态汇总。</p>
        </div>
        <button type="button" onClick={() => void dataApi.overview().then(setOverview)}>刷新</button>
      </header>
      <div className="data-grid data-grid--three">
        <section className="data-panel">
          <div className="data-panel__title"><h2>Datasets</h2></div>
          <strong className="data-metric">{overview?.summary.dataset_count ?? 0}</strong>
        </section>
        <section className="data-panel">
          <div className="data-panel__title"><h2>Packages</h2></div>
          <strong className="data-metric">{overview?.summary.package_count ?? 0}</strong>
        </section>
        <section className="data-panel">
          <div className="data-panel__title"><h2>Stages</h2></div>
          <pre>{overview ? JSON.stringify({ datasets: overview.summary.dataset_stage_counts, packages: overview.summary.package_stage_counts }, null, 2) : '{}'}</pre>
        </section>
      </div>
      <section className="data-panel">
        <div className="data-panel__title"><h2>Raw Overview</h2></div>
        <pre>{overview ? JSON.stringify(overview, null, 2) : 'Loading'}</pre>
      </section>
    </section>
  )
}
