import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '@/i18n'
import { useHumanReview } from '../store/useHumanReviewStore'
import { ReviewDatasetPicker } from '../components/ReviewDatasetPicker'
import { ReviewSummaryBar } from '../components/ReviewSummaryBar'
import { ReviewEpisodeList } from '../components/ReviewEpisodeList'
import { ReviewPlaybackPanel } from '../components/ReviewPlaybackPanel'
import { ReviewCommitDialog } from '../components/ReviewCommitDialog'

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable
}

export default function HumanReviewPage() {
  const { t } = useI18n()
  const selectedEpisodeIndex = useHumanReview((s) => s.selectedEpisodeIndex)
  const episodeDetail = useHumanReview((s) => s.episodeDetail)
  const goNext = useHumanReview((s) => s.goNext)
  const goPrev = useHumanReview((s) => s.goPrev)
  const setMark = useHumanReview((s) => s.setMark)

  const [commitOpen, setCommitOpen] = useState(false)

  const openCommit = useCallback(() => setCommitOpen(true), [])
  const closeCommit = useCallback(() => setCommitOpen(false), [])

  useEffect(() => {
    function handler(event: KeyboardEvent) {
      if (isTypingTarget(event.target)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        void goPrev()
        return
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault()
        void goNext()
        return
      }
      if (event.key === 'm' || event.key === 'M') {
        if (selectedEpisodeIndex == null) return
        const next = !(episodeDetail?.mark?.abnormal === true)
        event.preventDefault()
        void setMark(selectedEpisodeIndex, next)
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        setCommitOpen(true)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [goNext, goPrev, setMark, selectedEpisodeIndex, episodeDetail])

  return (
    <div className="page-enter quality-view pipeline-page">
      <div className="pipeline-page-title">
        <div>
          <h2>{t('humanReviewTitle')}</h2>
          <p>{t('humanReviewDesc')}</p>
        </div>
      </div>
      <ReviewDatasetPicker />
      <ReviewSummaryBar />
      <div
        className="pipeline-stack-card__grid"
        style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: 16 }}
      >
        <ReviewEpisodeList />
        <ReviewPlaybackPanel onOpenCommit={openCommit} />
      </div>
      <ReviewCommitDialog open={commitOpen} onClose={closeCommit} />
    </div>
  )
}
