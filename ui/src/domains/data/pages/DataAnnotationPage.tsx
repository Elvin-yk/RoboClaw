import { useEffect, useState } from 'react'
import { dataApi } from '@/domains/data/api/dataApi'
import { useDataJobStore } from '@/domains/data/store/jobStore'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'

export default function DataAnnotationPage() {
  const { packages, load } = useDataLibraryStore()
  const { attach } = useDataJobStore()
  const [packageId, setPackageId] = useState('')
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const [taskText, setTaskText] = useState('')
  const [workspace, setWorkspace] = useState<Record<string, unknown> | null>(null)

  useEffect(() => {
    void load()
  }, [load])

  async function loadWorkspace(nextPackageId = packageId, nextEpisodeIndex = episodeIndex) {
    if (!nextPackageId) return
    setWorkspace(await dataApi.annotationWorkspace(nextPackageId, nextEpisodeIndex))
  }

  async function save() {
    if (!packageId) return
    await dataApi.saveAnnotations({
      package_id: packageId,
      episode_index: episodeIndex,
      task_context: { task_text: taskText },
      annotations: [{ kind: 'task_text', text: taskText }],
    })
    await loadWorkspace()
  }

  async function runPrototype() {
    if (!packageId) return
    attach(await dataApi.startPrototypeRun({ package_id: packageId }))
  }

  async function runPropagation() {
    if (!packageId) return
    attach(await dataApi.startPropagationRun({ package_id: packageId, source_episode_index: episodeIndex }))
  }

  return (
    <section className="data-page">
      <header className="data-page__header">
        <div>
          <h1>语义标注</h1>
          <p>标注 workspace、prototype、propagation 都绑定 DatasetPackage。</p>
        </div>
      </header>

      <section className="data-panel">
        <div className="data-toolbar">
          <select
            value={packageId}
            onChange={(event) => {
              setPackageId(event.target.value)
              void loadWorkspace(event.target.value, episodeIndex)
            }}
          >
            <option value="">选择 DatasetPackage</option>
            {packages.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
          <input
            type="number"
            value={episodeIndex}
            onChange={(event) => {
              const next = Number(event.target.value)
              setEpisodeIndex(next)
              void loadWorkspace(packageId, next)
            }}
          />
          <button type="button" onClick={() => void loadWorkspace()}>加载</button>
        </div>
        <textarea value={taskText} onChange={(event) => setTaskText(event.target.value)} placeholder="task text" />
        <div className="data-toolbar">
          <button type="button" onClick={() => void save()} disabled={!packageId}>保存标注</button>
          <button type="button" onClick={() => void runPrototype()} disabled={!packageId}>Prototype</button>
          <button type="button" onClick={() => void runPropagation()} disabled={!packageId}>Propagation</button>
        </div>
      </section>

      <section className="data-panel">
        <div className="data-panel__title"><h2>Workspace</h2></div>
        <pre>{workspace ? JSON.stringify(workspace, null, 2) : 'No workspace loaded'}</pre>
      </section>
    </section>
  )
}
