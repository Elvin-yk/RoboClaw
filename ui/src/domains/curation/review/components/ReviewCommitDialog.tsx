import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useI18n } from '@/i18n'
import { ActionButton, GlassPanel } from '@/shared/ui'
import { useHumanReview } from '../store/useHumanReviewStore'

function defaultOutputName(sourceId: string | null): string {
  if (!sourceId) return ''
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return `${sourceId}_reviewed_${stamp}`
}

export function ReviewCommitDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useI18n()
  const selectedDatasetId = useHumanReview((s) => s.selectedDatasetId)
  const summary = useHumanReview((s) => s.summary)
  const commitInProgress = useHumanReview((s) => s.commitInProgress)
  const commitError = useHumanReview((s) => s.commitError)
  const commitResult = useHumanReview((s) => s.commitResult)
  const commitDeletion = useHumanReview((s) => s.commitDeletion)
  const clearCommitResult = useHumanReview((s) => s.clearCommitResult)

  const [outputName, setOutputName] = useState('')
  const [taskName, setTaskName] = useState('')
  const [dryRun, setDryRun] = useState(false)

  useEffect(() => {
    if (open) {
      setOutputName(defaultOutputName(selectedDatasetId))
      clearCommitResult()
    }
  }, [open, selectedDatasetId, clearCommitResult])

  useEffect(() => {
    if (!open) return
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const counts = useMemo(() => {
    if (!summary) return { kept: 0, deleted: 0 }
    return {
      kept: Math.max(summary.total_episodes - summary.abnormal, 0),
      deleted: summary.abnormal,
    }
  }, [summary])

  if (!open) return null

  function handleSubmit() {
    if (!selectedDatasetId || !outputName.trim()) return
    void commitDeletion(outputName.trim(), taskName, dryRun)
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div onClick={(event) => event.stopPropagation()} style={{ minWidth: 480, maxWidth: 640 }}>
        <GlassPanel>
          <h3>{t('reviewCommitDialogTitle')}</h3>
          <div className="workflow-view__info-bar">
            <span>{t('reviewKeptCount')}: {counts.kept}</span>
            <span>{t('reviewDeletedCount')}: {counts.deleted}</span>
          </div>
          <label style={{ display: 'block', marginTop: 12 }}>
            <span>{t('reviewCleanedDatasetName')}</span>
            <input
              type="text"
              className="dataset-selector__select"
              value={outputName}
              onChange={(event) => setOutputName(event.target.value)}
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            <span>{t('reviewCommitTaskLabel')}</span>
            <input
              type="text"
              className="dataset-selector__select"
              value={taskName}
              onChange={(event) => setTaskName(event.target.value)}
            />
          </label>
          <label style={{ display: 'block', marginTop: 12 }}>
            <input
              type="checkbox"
              checked={dryRun}
              onChange={(event) => setDryRun(event.target.checked)}
            />
            <span style={{ marginLeft: 8 }}>{t('reviewCommitDryRun')}</span>
          </label>

          {commitError && <p className="is-fail" style={{ marginTop: 12 }}>{commitError}</p>}

          {commitResult && (
            <div style={{ marginTop: 12 }}>
              <p>{t('reviewCommitSuccess')}</p>
              <p>
                {t('reviewKeptCount')}: {commitResult.kept_episode_indices.length} ·{' '}
                {t('reviewDeletedCount')}: {commitResult.deleted_episode_indices.length}
              </p>
              {commitResult.output_path && (
                <Link to={`/curation/datasets?dataset=${encodeURIComponent(commitResult.output_dataset)}`}>
                  {commitResult.output_dataset}
                </Link>
              )}
            </div>
          )}

          <div className="quality-results-card__filters" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            <ActionButton variant="secondary" onClick={onClose}>
              {t('reviewCommitCancel')}
            </ActionButton>
            <ActionButton
              variant="primary"
              disabled={commitInProgress || !outputName.trim()}
              onClick={handleSubmit}
            >
              {t('reviewCommitConfirm')}
            </ActionButton>
          </div>
        </GlassPanel>
      </div>
    </div>
  )
}

export default ReviewCommitDialog
