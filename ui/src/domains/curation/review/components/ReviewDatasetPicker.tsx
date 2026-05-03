import { useEffect } from 'react'
import { useI18n } from '@/i18n'
import { GlassPanel } from '@/shared/ui'
import { useHumanReview } from '../store/useHumanReviewStore'

export function ReviewDatasetPicker() {
  const { t } = useI18n()
  const datasets = useHumanReview((s) => s.datasets)
  const loading = useHumanReview((s) => s.loadingDatasets)
  const error = useHumanReview((s) => s.datasetsError)
  const selectedDatasetId = useHumanReview((s) => s.selectedDatasetId)
  const loadDatasets = useHumanReview((s) => s.loadDatasets)
  const selectDataset = useHumanReview((s) => s.selectDataset)

  useEffect(() => {
    void loadDatasets(true)
  }, [loadDatasets])

  if (loading) {
    return <GlassPanel>{t('reviewDataset')}…</GlassPanel>
  }
  if (error) {
    return <GlassPanel>{error}</GlassPanel>
  }
  if (datasets.length === 0) {
    return <GlassPanel>{t('reviewNoDatasets')}</GlassPanel>
  }

  return (
    <div className="dataset-selector">
      <label className="dataset-selector__label">
        <span>{t('reviewSelectDataset')}</span>
        <select
          className="dataset-selector__select"
          value={selectedDatasetId ?? ''}
          onChange={(event) => {
            const id = event.target.value
            if (id) void selectDataset(id)
          }}
        >
          <option value="">--</option>
          {datasets.map((ds) => (
            <option key={ds.id} value={ds.id}>
              {ds.label} · {ds.total_episodes} ep · {ds.fps}fps · {t('reviewReviewed')} {ds.reviewed} · {t('reviewAbnormal')} {ds.abnormal}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}

export default ReviewDatasetPicker
