import { useI18n, type TranslationKey } from '@/i18n'
import { ActionButton, GlassPanel } from '@/shared/ui'
import { cn } from '@/shared/lib/cn'
import { useHumanReview } from '../store/useHumanReviewStore'
import type { ReviewEpisodeListItem } from '../api'

function badgeLabel(item: ReviewEpisodeListItem, t: (key: TranslationKey) => string): string {
  if (!item.mark) return ''
  return item.mark.abnormal ? t('reviewAbnormal') : t('reviewReviewed')
}

export function ReviewEpisodeList() {
  const { t } = useI18n()
  const episodePage = useHumanReview((s) => s.episodePage)
  const pageLoading = useHumanReview((s) => s.pageLoading)
  const pageError = useHumanReview((s) => s.pageError)
  const selectedEpisodeIndex = useHumanReview((s) => s.selectedEpisodeIndex)
  const selectEpisode = useHumanReview((s) => s.selectEpisode)
  const loadEpisodePage = useHumanReview((s) => s.loadEpisodePage)

  if (pageError) {
    return <GlassPanel>{pageError}</GlassPanel>
  }
  if (!episodePage) {
    return <GlassPanel>{pageLoading ? '…' : '--'}</GlassPanel>
  }

  return (
    <GlassPanel className="quality-results-card">
      <div className="quality-table-wrap">
        <table className="quality-table">
          <thead>
            <tr>
              <th>Episode</th>
              <th>{t('reviewReviewed')}</th>
              <th>length</th>
            </tr>
          </thead>
          <tbody>
            {episodePage.episodes.map((row) => {
              const active = selectedEpisodeIndex === row.episode_index
              const abnormal = row.mark?.abnormal === true
              return (
                <tr
                  key={row.episode_index}
                  className={cn(
                    'quality-result-row',
                    active && 'quality-table__row--selected',
                    abnormal && 'is-fail',
                  )}
                  tabIndex={0}
                  onClick={() => void selectEpisode(row.episode_index)}
                >
                  <td>{row.episode_index}</td>
                  <td>{badgeLabel(row, t) || '-'}</td>
                  <td>{row.length}</td>
                </tr>
              )
            })}
            {episodePage.episodes.length === 0 && (
              <tr><td colSpan={3} className="quality-table__empty">--</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="quality-results-card__filters" style={{ marginTop: 8 }}>
        <ActionButton
          variant="secondary"
          onClick={() => void loadEpisodePage(Math.max(1, episodePage.page - 1))}
          disabled={episodePage.page <= 1 || pageLoading}
        >
          {t('reviewPrev')}
        </ActionButton>
        <span>{episodePage.page} / {episodePage.total_pages}</span>
        <ActionButton
          variant="secondary"
          onClick={() => void loadEpisodePage(Math.min(episodePage.total_pages, episodePage.page + 1))}
          disabled={episodePage.page >= episodePage.total_pages || pageLoading}
        >
          {t('reviewNext')}
        </ActionButton>
      </div>
    </GlassPanel>
  )
}

export default ReviewEpisodeList
