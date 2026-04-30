import { type QualityEpisodeResult } from '@/domains/curation/store/useCurationStore'
import {
  cn,
  formatCheckLabel,
  formatQualityCheckDetail,
  formatValidatorLabel,
  groupQualityIssues,
} from './qualityValidationUtils'

export default function QualityDetailInspector({
  episode,
  locale,
}: {
  episode: QualityEpisodeResult
  locale: 'zh' | 'en'
}) {
  const copy = locale === 'zh'
    ? {
      title: '检测详情',
      validatorSummary: '验证器汇总',
      checks: '检查项',
      noDetails: '没有详细检查记录',
    }
    : {
      title: 'Validation Details',
      validatorSummary: 'Validator Summary',
      checks: 'Checks',
      noDetails: 'No detailed check records',
    }
  const issueGroups = groupQualityIssues(episode.issues || [])
  const validatorEntries = Object.entries(episode.validators || {})

  return (
    <div className="quality-detail-inspector">
      <div className="quality-detail-inspector__head">
        <div>
          <div className="quality-detail-inspector__eyebrow">{copy.title}</div>
          <h4>Episode {episode.episode_index}</h4>
        </div>
        <div className="quality-detail-inspector__score">
          <span>{episode.score.toFixed(1)}</span>
          <span className={cn(episode.passed ? 'is-pass' : 'is-fail')}>
            {episode.passed ? (locale === 'zh' ? '通过' : 'Passed') : (locale === 'zh' ? '未通过' : 'Failed')}
          </span>
        </div>
      </div>

      {validatorEntries.length > 0 && (
        <div className="quality-detail-summary" aria-label={copy.validatorSummary}>
          {validatorEntries.map(([name, validator]) => (
            <div
              key={name}
              className={cn('quality-detail-summary__item', validator.passed ? 'is-pass' : 'is-fail')}
            >
              <span>{formatValidatorLabel(name, locale)}</span>
              <strong>{validator.score.toFixed(1)}</strong>
            </div>
          ))}
        </div>
      )}

      {issueGroups.length > 0 ? (
        <div className="quality-detail-groups">
          {issueGroups.map((group) => (
            <section key={group.validator} className="quality-detail-group">
              <div className="quality-detail-group__title">
                <span>{formatValidatorLabel(group.validator, locale)}</span>
                <span>{group.checks.length} {copy.checks}</span>
              </div>
              <div className="quality-detail-checks">
                {group.checks.map((issue, index) => {
                  const checkName = issue['check_name']
                  const checkKey = typeof checkName === 'string' && checkName.trim()
                    ? checkName
                    : `check-${index}`
                  const passed = issue['passed'] === true
                  const detail = formatQualityCheckDetail(issue, locale)
                  return (
                    <div
                      key={`${group.validator}-${checkKey}-${index}`}
                      title={checkKey}
                      className={cn('quality-detail-check', passed ? 'is-pass' : 'is-fail')}
                    >
                      <div className="quality-detail-check__line">
                        <span className={cn('quality-detail-check__status', passed ? 'is-pass' : 'is-fail')}>
                          {passed ? '✓' : '×'}
                        </span>
                        <span className="quality-detail-check__name">
                          {formatCheckLabel(checkKey, locale)}
                        </span>
                        {detail && <span className="quality-detail-check__message">: {detail}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="quality-detail-inspector__empty">{copy.noDetails}</div>
      )}
    </div>
  )
}
