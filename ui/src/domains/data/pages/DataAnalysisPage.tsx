import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { DataAnalysisWorkspace } from '@/domains/data/components/DataAnalysisWorkspace'
import { useDataInspectWorkspace } from '@/domains/data/store/inspectStore'
import { useI18n } from '@/i18n'

export default function DataAnalysisPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { t } = useI18n()
  const {
    source,
    dataset,
    summary,
    details,
    episodes,
    episode,
    loading,
    error,
    reset,
    setSource,
    setDataset,
    inspect,
    loadEpisode,
  } = useDataInspectWorkspace()
  const [episodeIndex, setEpisodeIndex] = useState(0)
  const loadedDatasetFromQuery = useRef('')
  const loadRequestRef = useRef(0)
  const datasetFromQuery = searchParams.get('dataset') || ''
  const returnTo = searchParams.get('returnTo') || ''
  const manageDataset = searchParams.get('manageDataset') || datasetFromQuery
  const qcDataset = searchParams.get('qcDataset') || datasetFromQuery
  const packageFromQuery = searchParams.get('package') || ''
  const displayDataset = dataset.trim() || datasetFromQuery || packageFromQuery

  useEffect(() => {
    if (!datasetFromQuery && !packageFromQuery) {
      navigate('/data/manage', { replace: true })
      return
    }
    if (!datasetFromQuery) {
      if (loadedDatasetFromQuery.current) {
        loadedDatasetFromQuery.current = ''
        loadRequestRef.current += 1
        reset()
        setEpisodeIndex(0)
      }
      return
    }
    if (loadedDatasetFromQuery.current === datasetFromQuery) return
    loadedDatasetFromQuery.current = datasetFromQuery
    const requestId = ++loadRequestRef.current
    setSource('local')
    setDataset(datasetFromQuery)
    void (async () => {
      await inspect()
      if (requestId !== loadRequestRef.current) return
      setEpisodeIndex(0)
      await loadEpisode(0)
    })()
  }, [datasetFromQuery, inspect, loadEpisode, navigate, packageFromQuery, reset, setDataset, setSource])

  async function loadSelectedEpisode(nextEpisodeIndex = episodeIndex) {
    loadRequestRef.current += 1
    setEpisodeIndex(nextEpisodeIndex)
    await loadEpisode(nextEpisodeIndex)
  }

  function returnToManage() {
    const targetDataset = manageDataset || dataset.trim()
    const query = targetDataset ? `?dataset=${encodeURIComponent(targetDataset)}` : ''
    navigate(`/data/manage${query}`)
  }

  function returnToPreviousPage() {
    if (returnTo === 'data-qc') {
      const targetDataset = qcDataset || dataset.trim()
      const query = targetDataset ? `?dataset=${encodeURIComponent(targetDataset)}` : ''
      navigate(`/data/qc${query}`)
      return
    }
    returnToManage()
  }

  return (
    <section className="data-page data-analysis-page">
      {(returnTo === 'data-manage' || returnTo === 'data-qc') && (
        <div className="data-analysis-toolbar">
          <button type="button" className="data-analysis-return" onClick={returnToPreviousPage}>
            {t(returnTo === 'data-qc' ? 'dataAnalysisBackToQc' : 'dataAnalysisBackToManage')}
          </button>
        </div>
      )}

      <section className="data-panel">
        <div className="data-analysis-dataset-heading">
          <span>{t('dataAnalysisDatasetName')}</span>
          <strong>{displayDataset}</strong>
        </div>
        {error && <div className="data-alert">{error}</div>}
      </section>

      <DataAnalysisWorkspace
        source={source}
        dataset={dataset}
        summary={summary}
        details={details}
        episodes={episodes}
        episode={episode}
        episodeIndex={episodeIndex}
        loading={loading}
        canLoadEpisode={Boolean(dataset.trim())}
        onEpisodeIndexChange={setEpisodeIndex}
        onLoadEpisode={(nextEpisodeIndex) => void loadSelectedEpisode(nextEpisodeIndex)}
      />
    </section>
  )
}
