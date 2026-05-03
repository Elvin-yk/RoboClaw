import { create } from 'zustand'
import {
  fetchReviewDatasets,
  fetchReviewEpisodeDetail,
  fetchReviewEpisodePage,
  fetchReviewState,
  postCommitDeletion,
  putReviewMark,
  type CommitDeletionResult,
  type ReviewDatasetSummary,
  type ReviewEpisodeDetail,
  type ReviewEpisodeListItem,
  type ReviewEpisodePage,
  type ReviewMark,
  type ReviewSummary,
} from '../api'

const DEFAULT_PAGE_SIZE = 50

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyMarkToPage(
  page: ReviewEpisodePage | null,
  episodeIndex: number,
  mark: ReviewMark | null,
): ReviewEpisodePage | null {
  if (!page) return page
  let touched = false
  const episodes: ReviewEpisodeListItem[] = page.episodes.map((row) => {
    if (row.episode_index !== episodeIndex) return row
    touched = true
    return { ...row, mark }
  })
  return touched ? { ...page, episodes } : page
}

function recomputeSummary(
  prev: ReviewSummary | null,
  before: ReviewMark | null,
  after: ReviewMark | null,
): ReviewSummary | null {
  if (!prev) return prev
  const beforeReviewed = before ? 1 : 0
  const afterReviewed = after ? 1 : 0
  const beforeAbnormal = before?.abnormal ? 1 : 0
  const afterAbnormal = after?.abnormal ? 1 : 0
  return {
    total_episodes: prev.total_episodes,
    reviewed: prev.reviewed + (afterReviewed - beforeReviewed),
    abnormal: prev.abnormal + (afterAbnormal - beforeAbnormal),
  }
}

interface ReviewStoreState {
  datasets: ReviewDatasetSummary[]
  selectedDatasetId: string | null
  loadingDatasets: boolean
  datasetsError: string

  summary: ReviewSummary | null
  episodePage: ReviewEpisodePage | null
  pageLoading: boolean
  pageError: string

  selectedEpisodeIndex: number | null
  episodeDetail: ReviewEpisodeDetail | null
  detailLoading: boolean
  detailError: string

  markBusyIndex: number | null
  markError: string

  commitInProgress: boolean
  commitError: string
  commitResult: CommitDeletionResult | null

  loadDatasets: (criticalOnly?: boolean) => Promise<void>
  selectDataset: (datasetId: string) => Promise<void>
  loadEpisodePage: (page?: number) => Promise<void>
  selectEpisode: (episodeIndex: number) => Promise<void>
  goNext: () => Promise<void>
  goPrev: () => Promise<void>
  setMark: (episodeIndex: number, abnormal: boolean) => Promise<void>
  commitDeletion: (outputDatasetId: string, task: string, dryRun: boolean) => Promise<void>
  clearCommitResult: () => void
  reset: () => void
}

export const useHumanReview = create<ReviewStoreState>((set, get) => ({
  datasets: [],
  selectedDatasetId: null,
  loadingDatasets: false,
  datasetsError: '',

  summary: null,
  episodePage: null,
  pageLoading: false,
  pageError: '',

  selectedEpisodeIndex: null,
  episodeDetail: null,
  detailLoading: false,
  detailError: '',

  markBusyIndex: null,
  markError: '',

  commitInProgress: false,
  commitError: '',
  commitResult: null,

  async loadDatasets(criticalOnly = true) {
    set({ loadingDatasets: true, datasetsError: '' })
    try {
      const datasets = await fetchReviewDatasets(criticalOnly)
      set({ datasets, loadingDatasets: false })
    } catch (error) {
      set({ datasets: [], loadingDatasets: false, datasetsError: errorMessage(error) })
    }
  },

  async selectDataset(datasetId) {
    if (get().selectedDatasetId === datasetId) {
      return
    }
    set({
      selectedDatasetId: datasetId,
      summary: null,
      episodePage: null,
      pageError: '',
      selectedEpisodeIndex: null,
      episodeDetail: null,
      detailError: '',
      markError: '',
      commitResult: null,
      commitError: '',
    })
    const stateRequest = fetchReviewState(datasetId).then(
      ({ summary }) => {
        if (get().selectedDatasetId !== datasetId) return
        set({ summary })
      },
      (error: unknown) => {
        if (get().selectedDatasetId !== datasetId) return
        set({ pageError: errorMessage(error) })
      },
    )
    await Promise.all([stateRequest, get().loadEpisodePage(1)])
    if (get().selectedDatasetId !== datasetId) return
    const firstEpisode = get().episodePage?.episodes[0]
    if (firstEpisode) {
      await get().selectEpisode(firstEpisode.episode_index)
    }
  },

  async loadEpisodePage(page = 1) {
    const datasetId = get().selectedDatasetId
    if (!datasetId) return
    set({ pageLoading: true, pageError: '' })
    try {
      const episodePage = await fetchReviewEpisodePage(datasetId, page, DEFAULT_PAGE_SIZE)
      if (get().selectedDatasetId !== datasetId) return
      set({ episodePage, pageLoading: false })
      const current = get().selectedEpisodeIndex
      const onPage =
        current != null
        && episodePage.episodes.some((row) => row.episode_index === current)
      if (!onPage && episodePage.episodes[0]) {
        await get().selectEpisode(episodePage.episodes[0].episode_index)
      }
    } catch (error) {
      if (get().selectedDatasetId !== datasetId) return
      set({ pageLoading: false, pageError: errorMessage(error) })
    }
  },

  async selectEpisode(episodeIndex) {
    const datasetId = get().selectedDatasetId
    if (!datasetId) return
    set({
      selectedEpisodeIndex: episodeIndex,
      detailLoading: true,
      detailError: '',
      episodeDetail: null,
    })
    try {
      const detail = await fetchReviewEpisodeDetail(datasetId, episodeIndex)
      if (get().selectedEpisodeIndex !== episodeIndex) return
      set({ episodeDetail: detail, detailLoading: false })
    } catch (error) {
      if (get().selectedEpisodeIndex !== episodeIndex) return
      set({ detailLoading: false, detailError: errorMessage(error) })
    }
  },

  async goNext() {
    const { episodePage, selectedEpisodeIndex } = get()
    if (!episodePage || selectedEpisodeIndex == null) return
    const idx = episodePage.episodes.findIndex((e) => e.episode_index === selectedEpisodeIndex)
    if (idx < 0) return
    if (idx < episodePage.episodes.length - 1) {
      await get().selectEpisode(episodePage.episodes[idx + 1].episode_index)
      return
    }
    if (episodePage.page < episodePage.total_pages) {
      await get().loadEpisodePage(episodePage.page + 1)
      const next = get().episodePage?.episodes[0]
      if (next) {
        await get().selectEpisode(next.episode_index)
      }
    }
  },

  async goPrev() {
    const { episodePage, selectedEpisodeIndex } = get()
    if (!episodePage || selectedEpisodeIndex == null) return
    const idx = episodePage.episodes.findIndex((e) => e.episode_index === selectedEpisodeIndex)
    if (idx < 0) return
    if (idx > 0) {
      await get().selectEpisode(episodePage.episodes[idx - 1].episode_index)
      return
    }
    if (episodePage.page > 1) {
      await get().loadEpisodePage(episodePage.page - 1)
      const prevPage = get().episodePage
      const last = prevPage?.episodes[prevPage.episodes.length - 1]
      if (last) {
        await get().selectEpisode(last.episode_index)
      }
    }
  },

  async setMark(episodeIndex, abnormal) {
    const datasetId = get().selectedDatasetId
    if (!datasetId) return
    if (episodeIndex !== get().selectedEpisodeIndex) return
    const prevPage = get().episodePage
    const prevDetail = get().episodeDetail
    const prevSummary = get().summary
    const prevMark =
      prevPage?.episodes.find((e) => e.episode_index === episodeIndex)?.mark
      ?? (prevDetail?.episode_index === episodeIndex ? prevDetail.mark : null)
    const optimisticMark: ReviewMark = {
      episode_index: episodeIndex,
      abnormal,
      updated_at: new Date().toISOString(),
    }

    set({
      markBusyIndex: episodeIndex,
      markError: '',
      episodePage: applyMarkToPage(prevPage, episodeIndex, optimisticMark),
      episodeDetail:
        prevDetail && prevDetail.episode_index === episodeIndex
          ? { ...prevDetail, mark: optimisticMark }
          : prevDetail,
      summary: recomputeSummary(prevSummary, prevMark ?? null, optimisticMark),
    })

    try {
      await putReviewMark(datasetId, episodeIndex, abnormal)
      if (get().selectedDatasetId !== datasetId) return
      const refreshed = await fetchReviewState(datasetId)
      if (get().selectedDatasetId !== datasetId) return
      set({ summary: refreshed.summary, markBusyIndex: null })
    } catch (error) {
      const stillCurrent =
        get().selectedDatasetId === datasetId
        && get().selectedEpisodeIndex === episodeIndex
      if (!stillCurrent) {
        set({ markBusyIndex: null, markError: errorMessage(error) })
        return
      }
      set({
        markBusyIndex: null,
        markError: errorMessage(error),
        episodePage: applyMarkToPage(get().episodePage, episodeIndex, prevMark ?? null),
        episodeDetail:
          get().episodeDetail && get().episodeDetail!.episode_index === episodeIndex
            ? { ...get().episodeDetail!, mark: prevMark ?? null }
            : get().episodeDetail,
        summary: prevSummary,
      })
    }
  },

  async commitDeletion(outputDatasetId, task, dryRun) {
    const datasetId = get().selectedDatasetId
    if (!datasetId) return
    set({ commitInProgress: true, commitError: '', commitResult: null })
    try {
      const result = await postCommitDeletion(datasetId, outputDatasetId, task, dryRun)
      set({ commitResult: result, commitInProgress: false })
      if (!dryRun) {
        await get().loadDatasets()
      }
    } catch (error) {
      set({ commitInProgress: false, commitError: errorMessage(error) })
    }
  },

  clearCommitResult() {
    set({ commitResult: null, commitError: '' })
  },

  reset() {
    set({
      datasets: [],
      selectedDatasetId: null,
      loadingDatasets: false,
      datasetsError: '',
      summary: null,
      episodePage: null,
      pageLoading: false,
      pageError: '',
      selectedEpisodeIndex: null,
      episodeDetail: null,
      detailLoading: false,
      detailError: '',
      markBusyIndex: null,
      markError: '',
      commitInProgress: false,
      commitError: '',
      commitResult: null,
    })
  },
}))
