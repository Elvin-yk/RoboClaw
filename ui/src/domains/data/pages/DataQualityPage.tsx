import { useEffect, useState } from 'react'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'

export default function DataQualityPage() {
  const { packages, load } = useDataLibraryStore()
  const { attach } = useDataJobStore()
  const [packageId, setPackageId] = useState('')
  const [defaults, setDefaults] = useState<Record<string, unknown> | null>(null)
  const [results, setResults] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  async function selectPackage(nextPackageId: string) {
    setPackageId(nextPackageId)
    const nextDefaults = await dataApi.qualityDefaults(nextPackageId)
    const nextResults = await dataApi.qualityResults(nextPackageId)
    setDefaults(nextDefaults)
    setResults(nextResults)
  }

  async function runQuality() {
    if (!packageId || !defaults) return
    const selected = defaults.selected_validators
    const job = await dataApi.startQualityRun({
      package_id: packageId,
      selected_validators: Array.isArray(selected) ? selected.map(String) : ['metadata'],
    })
    attach(job)
  }

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>质量验证</h1>
          <p>质量验证只针对 DatasetPackage 运行。</p>
        </div>
        <button type="button" onClick={() => void runQuality()} disabled={!packageId}>运行</button>
      </header>

      <section className="data-panel">
        <div className="data-toolbar">
          <select value={packageId} onChange={(event) => void selectPackage(event.target.value)}>
            <option value="">选择 DatasetPackage</option>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
      </section>

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title"><h2>Defaults</h2></div>
          <pre>{defaults ? JSON.stringify(defaults, null, 2) : 'No package selected'}</pre>
        </section>
        <section className="data-panel">
          <div className="data-panel__title"><h2>Results</h2></div>
          <pre>{results ? JSON.stringify(results, null, 2) : 'No results loaded'}</pre>
        </section>
      </div>
    </section>
  )
}
