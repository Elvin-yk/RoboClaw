import { useState } from 'react'
import { useI18n } from '@/i18n'
import { ActionButton, GlassPanel } from '@/shared/ui'
import { useHumanReview } from '../store/useHumanReviewStore'
import { ReviewVideoPlayer } from './ReviewVideoPlayer'

export function ReviewPlaybackPanel({ onOpenCommit }: { onOpenCommit: () => void }) {
  const { t } = useI18n()
  const detail = useHumanReview((s) => s.episodeDetail)
  const detailLoading = useHumanReview((s) => s.detailLoading)
  const detailError = useHumanReview((s) => s.detailError)
  const selectedEpisodeIndex = useHumanReview((s) => s.selectedEpisodeIndex)
  const markBusyIndex = useHumanReview((s) => s.markBusyIndex)
  const markError = useHumanReview((s) => s.markError)
  const goNext = useHumanReview((s) => s.goNext)
  const goPrev = useHumanReview((s) => s.goPrev)
  const setMark = useHumanReview((s) => s.setMark)

  const [playVideo, setPlayVideo] = useState(true)

  if (detailError) {
    return <GlassPanel>{detailError}</GlassPanel>
  }
  if (selectedEpisodeIndex == null) {
    return <GlassPanel>{t('reviewCurrentEpisode')}: --</GlassPanel>
  }
  if (detailLoading || !detail) {
    return <GlassPanel>…</GlassPanel>
  }

  const isAbnormal = detail.mark?.abnormal === true
  const busy = markBusyIndex === detail.episode_index

  return (
    <GlassPanel>
      <div className="quality-results-card__head">
        <div>
          <h3>{t('reviewCurrentEpisode')}: {detail.episode_index}</h3>
          {markError && <p className="is-fail">{markError}</p>}
        </div>
        <div className="quality-results-card__filters">
          <ActionButton variant="secondary" onClick={() => void goPrev()}>
            {t('reviewPrev')}
          </ActionButton>
          <ActionButton variant="secondary" onClick={() => void goNext()}>
            {t('reviewNext')}
          </ActionButton>
          <ActionButton
            variant="secondary"
            onClick={() => setPlayVideo((v) => !v)}
          >
            {playVideo ? '⏸' : '▶'}
          </ActionButton>
          <ActionButton
            variant={isAbnormal ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => void setMark(detail.episode_index, !isAbnormal)}
          >
            {isAbnormal ? t('markNormal') : t('markAbnormal')}
          </ActionButton>
          <ActionButton variant="primary" onClick={onOpenCommit}>
            {t('reviewCommitDeletion')}
          </ActionButton>
        </div>
      </div>
      <ReviewVideoPlayer
        videos={detail.videos}
        playVideo={playVideo}
        emptyLabel={t('reviewCurrentEpisode')}
      />
    </GlassPanel>
  )
}

export default ReviewPlaybackPanel
