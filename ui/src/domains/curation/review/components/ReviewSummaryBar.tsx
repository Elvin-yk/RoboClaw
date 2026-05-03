import { useI18n } from '@/i18n'
import { useHumanReview } from '../store/useHumanReviewStore'

export function ReviewSummaryBar() {
  const { t } = useI18n()
  const summary = useHumanReview((s) => s.summary)
  const selectedEpisodeIndex = useHumanReview((s) => s.selectedEpisodeIndex)

  if (!summary) return null

  return (
    <div className="workflow-view__info-bar">
      <span>{t('reviewTotalEpisodes')}: {summary.total_episodes}</span>
      <span>{t('reviewReviewed')}: {summary.reviewed}</span>
      <span>{t('reviewAbnormal')}: {summary.abnormal}</span>
      <span>
        {t('reviewCurrentEpisode')}: {selectedEpisodeIndex ?? '--'}
      </span>
    </div>
  )
}

export default ReviewSummaryBar
