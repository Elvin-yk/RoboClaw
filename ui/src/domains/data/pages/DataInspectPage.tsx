import { useDataInspectStore } from '@/domains/data/store/inspectStore'

export default function DataInspectPage() {
  const {
    source,
    query,
    dataset,
    path,
    suggestions,
    summary,
    details,
    episodes,
    loading,
    error,
    setSource,
    setQuery,
    setDataset,
    setPath,
    suggest,
    inspect,
  } = useDataInspectStore()

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>数据检查</h1>
          <p>远程 HF 数据只做 direct inspect；本地数据可进入后续生命周期。</p>
        </div>
      </header>

      <section className="data-panel">
        <div className="data-toolbar">
          <select value={source} onChange={(event) => setSource(event.target.value as 'remote' | 'local' | 'path')}>
            <option value="local">local</option>
            <option value="remote">remote</option>
            <option value="path">path</option>
          </select>
          {source === 'path' ? (
            <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/absolute/dataset/path" />
          ) : (
            <input value={dataset} onChange={(event) => setDataset(event.target.value)} placeholder="dataset id" />
          )}
          <button type="button" onClick={() => void inspect()} disabled={loading}>检查</button>
        </div>
        <div className="data-toolbar">
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 dataset" />
          <button type="button" onClick={() => void suggest()}>搜索</button>
        </div>
        {!!suggestions.length && (
          <div className="data-suggestions">
            {suggestions.map((item) => (
              <button key={item.id} type="button" onClick={() => setDataset(item.id)}>{item.label || item.id}</button>
            ))}
          </div>
        )}
      </section>

      {error && <div className="data-alert">{error}</div>}

      <div className="data-grid data-grid--two">
        <section className="data-panel">
          <div className="data-panel__title"><h2>Summary</h2></div>
          <pre>{summary ? JSON.stringify(summary, null, 2) : 'No summary loaded'}</pre>
        </section>
        <section className="data-panel">
          <div className="data-panel__title"><h2>Details</h2></div>
          <pre>{details ? JSON.stringify(details, null, 2) : 'No details loaded'}</pre>
        </section>
      </div>
      <section className="data-panel">
        <div className="data-panel__title"><h2>Episodes</h2></div>
        <pre>{episodes ? JSON.stringify(episodes, null, 2) : 'No episodes loaded'}</pre>
      </section>
    </section>
  )
}
