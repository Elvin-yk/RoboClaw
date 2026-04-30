import { useEffect, useMemo, useRef, useState } from 'react'
import { useI18n } from '@/i18n'
import {
  useWorkflow,
  type AnnotationItem,
  type AnnotationWorkspacePayload,
  type WorkflowTaskContext,
} from '@/domains/curation/store/useCurationStore'
import AnnotationWorkspaceCard from './AnnotationWorkspaceCard'
import JointComparisonWorkbench from './JointComparisonWorkbench'
import {
  ANNOTATION_SEED_COLORS,
  CLIP_TIME_EPSILON,
  buildComparisonSelectionKey,
  buildDefaultAnnotationText,
  buildJointComparisonEntries,
  clampAnnotationTime,
  clampToClipWindow,
  deriveAnnotationLabel,
  findClosestPlaybackIndex,
  formatSeconds,
  formatValue,
  getClipEnd,
  getClipStart,
  getRelativePlaybackTime,
  isFiniteNumber,
  matchComparisonSelectionKey,
  normalizeAnnotation,
  normalizeSavedComparisonContext,
  type SavedComparisonContext,
} from './annotationPanelUtils'

export default function AnnotationPanel() {
  const { locale } = useI18n()
  const {
    prototypeResults,
    workflowState,
    propagationResults,
    fetchAnnotationWorkspace,
    saveAnnotations,
    runPropagation,
    loadPropagationResults,
    refreshState,
  } = useWorkflow()

  const copy = locale === 'zh'
    ? {
        selectAnchor: '选择一个 anchor episode 开始标注。',
        runPrototypeFirst: '先完成原型发现，系统会为每个聚类给出 anchor episode。',
        anchors: 'Anchor Episodes',
        anchorsDesc: '每个聚类选一个代表性 episode 作为人工标注入口。',
        cluster: '聚类',
        members: '成员数',
        quality: '质量',
        annotated: '已标注',
        propagationDone: '已传播',
        propagationPending: '未传播',
        loadingWorkspace: '正在加载标注工作台...',
        saveAnnotationVersion: '保存标注',
        saving: '保存中...',
        runPropagation: '运行传播',
        saveAndPropagate: '先保存再传播',
        propagating: '传播中...',
        streamLabel: '视频流',
        syncedAxes: 'Action / State 关节对比',
        syncedAxesHint: '保留每个关节的 Action / State 对比，并跟随当前视频时间同步游标。',
        currentCursor: '当前游标',
        focusJoint: '当前对比关节',
        focusActionValue: 'Action 值',
        focusStateValue: 'State 值',
        focusFrame: '帧索引',
        restoreSource: '恢复来源',
        noJointData: '当前 episode 没有可展示的 Action / State 关节对比。',
        actionSeries: 'Action',
        stateSeries: 'State',
        unknownJoint: '未知关节',
        workspaceStatus: '工作台状态',
        savedVersion: '保存版本',
        savedAt: '保存时间',
        notSavedYet: '尚未保存',
        annotationCount: '标注数量',
        noVideoData: '当前 episode 没有可用于标注的视频。',
        saveBeforeSwitch: '切换 anchor 前会自动保存当前修改。',
        targetCount: '传播目标',
        switchVideo: '切换视频流',
      }
    : {
        selectAnchor: 'Select an anchor episode to start annotating.',
        runPrototypeFirst: 'Run prototype discovery first so the system can generate one anchor episode per cluster.',
        anchors: 'Anchor Episodes',
        anchorsDesc: 'Each cluster exposes one representative episode as the manual-annotation entrypoint.',
        cluster: 'Cluster',
        members: 'Members',
        quality: 'Quality',
        annotated: 'Annotated',
        propagationDone: 'Propagated',
        propagationPending: 'Not propagated',
        loadingWorkspace: 'Loading annotation workspace...',
        saveAnnotationVersion: 'Save Annotations',
        saving: 'Saving...',
        runPropagation: 'Run Propagation',
        saveAndPropagate: 'Save & Propagate',
        propagating: 'Propagating...',
        streamLabel: 'Stream',
        syncedAxes: 'Action / State Joint Comparison',
        syncedAxesHint: 'Keep per-joint Action / State comparison and sync the cursor with the current video time.',
        currentCursor: 'Cursor',
        focusJoint: 'Focused Joint',
        focusActionValue: 'Action Value',
        focusStateValue: 'State Value',
        focusFrame: 'Frame Index',
        restoreSource: 'Restore Source',
        noJointData: 'No Action / State joint comparison is available for this episode.',
        actionSeries: 'Action',
        stateSeries: 'State',
        unknownJoint: 'Unknown Joint',
        workspaceStatus: 'Workspace Status',
        savedVersion: 'Saved Version',
        savedAt: 'Saved At',
        notSavedYet: 'Not saved yet',
        annotationCount: 'Annotations',
        noVideoData: 'No video stream is available for this episode.',
        saveBeforeSwitch: 'The current draft will be auto-saved before switching anchors.',
        targetCount: 'Targets',
        switchVideo: 'Switch Stream',
      }

  const anchorItems = useMemo(() => {
    const annotatedSet = new Set(workflowState?.stages.annotation.annotated_episodes || [])
    const propagatedSourceSet = new Set([
      ...(workflowState?.stages.annotation.propagated_source_episodes || []),
      ...(propagationResults?.source_episode_indices || []),
      ...(propagationResults?.source_episode_index !== null && propagationResults?.source_episode_index !== undefined
        ? [propagationResults.source_episode_index]
        : []),
    ])
    return (prototypeResults?.clusters || [])
      .map((cluster) => {
        const episodeIndex = Number(cluster.anchor_record_key)
        if (!Number.isFinite(episodeIndex)) return null
        const anchorMember =
          cluster.members.find((member) => member.record_key === cluster.anchor_record_key) ||
          cluster.members[0]
        return {
          episodeIndex,
          clusterIndex: cluster.cluster_index,
          memberCount: cluster.member_count,
          qualityScore: anchorMember?.quality?.score ?? null,
          qualityPassed: anchorMember?.quality?.passed ?? null,
          annotated: annotatedSet.has(episodeIndex),
          propagated: propagatedSourceSet.has(episodeIndex),
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }, [prototypeResults, propagationResults, workflowState])

  const [selectedAnchorEpisode, setSelectedAnchorEpisode] = useState<number | null>(null)
  const [workspace, setWorkspace] = useState<AnnotationWorkspacePayload | null>(null)
  const [workspaceLoading, setWorkspaceLoading] = useState(false)
  const [workspaceError, setWorkspaceError] = useState('')
  const [annotations, setAnnotations] = useState<AnnotationItem[]>([])
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const [selectedVideoPath, setSelectedVideoPath] = useState('')
  const [playbackState, setPlaybackState] = useState({ index: 0, time: 0 })
  const [isStudioPaused, setIsStudioPaused] = useState(true)
  const [selectedComparisonKey, setSelectedComparisonKey] = useState('')
  const [pendingRestoreContext, setPendingRestoreContext] = useState<SavedComparisonContext | null>(null)
  const [saveState, setSaveState] = useState({
    isSaving: false,
    error: '',
    versionNumber: 0,
    savedAt: '',
  })
  const [propagationState, setPropagationState] = useState({
    isRunning: false,
    error: '',
  })

  const annotationIdRef = useRef(0)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const propagationRequestPendingRef = useRef(false)
  const propagationRunAcceptedRef = useRef(false)

  const effectiveSelectedVideo = useMemo(() => {
    if (!workspace?.videos.length) return null
    return (
      workspace.videos.find((video) => video.path === selectedVideoPath) ||
      workspace.videos[0]
    )
  }, [selectedVideoPath, workspace])

  const comparisonEntries = useMemo(
    () => buildJointComparisonEntries(workspace?.joint_trajectory || null),
    [workspace],
  )
  const activeComparisonEntry =
    comparisonEntries.find(
      (entry) => buildComparisonSelectionKey(entry) === selectedComparisonKey,
    ) ||
    comparisonEntries[0] ||
    null
  const frameValues = workspace?.joint_trajectory.frame_values || []
  const currentFrame = frameValues[playbackState.index] ?? null
  const timelineDuration = useMemo(() => {
    const clipStart = getClipStart(effectiveSelectedVideo)
    const clipEnd = getClipEnd(effectiveSelectedVideo)
    if (isFiniteNumber(clipEnd)) {
      return Math.max(clipEnd - clipStart, 0)
    }
    if (workspace?.summary.duration_s) {
      return workspace.summary.duration_s
    }
    const timeValues = workspace?.joint_trajectory.time_values || []
    if (timeValues.length > 1) {
      return Math.max(timeValues[timeValues.length - 1] - timeValues[0], 0)
    }
    return 0
  }, [effectiveSelectedVideo, workspace])

  const comparisonSnapshot = useMemo(() => {
    if (!activeComparisonEntry) {
      return {
        joint_name: '',
        time_s: Number(playbackState.time.toFixed(3)),
        frame_index: currentFrame,
        action_value: null,
        state_value: null,
        source: 'annotation_workspace',
      }
    }

    return {
      joint_name: activeComparisonEntry.label,
      time_s: Number(playbackState.time.toFixed(3)),
      frame_index: currentFrame,
      action_value: activeComparisonEntry.actionValues[playbackState.index] ?? null,
      state_value: activeComparisonEntry.stateValues[playbackState.index] ?? null,
      source: 'annotation_workspace',
    }
  }, [activeComparisonEntry, currentFrame, playbackState.index, playbackState.time])

  const taskContext = useMemo<WorkflowTaskContext>(() => {
    const defaultText = buildDefaultAnnotationText(workspace?.summary || null)
    return {
      label:
        workspace?.summary.task_label ||
        workspace?.summary.task_value ||
        'Task',
      text: defaultText,
      ...comparisonSnapshot,
    }
  }, [comparisonSnapshot, workspace])

  const latestPropagation =
    propagationResults?.source_episode_index === selectedAnchorEpisode
      ? propagationResults
      : workspace?.latest_propagation || null

  useEffect(() => {
    if (!anchorItems.length) {
      setSelectedAnchorEpisode(null)
      setWorkspace(null)
      return
    }
    setSelectedAnchorEpisode((currentValue) => {
      if (
        currentValue !== null &&
        anchorItems.some((item) => item.episodeIndex === currentValue)
      ) {
        return currentValue
      }
      return anchorItems[0].episodeIndex
    })
  }, [anchorItems])

  useEffect(() => {
    if (!workspace?.videos.length) {
      setSelectedVideoPath('')
      return
    }
    setSelectedVideoPath((currentPath) => {
      if (workspace.videos.some((video) => video.path === currentPath)) {
        return currentPath
      }
      return workspace.videos[0].path
    })
  }, [workspace])

  useEffect(() => {
    if (selectedAnchorEpisode === null) return

    let active = true
    setWorkspaceLoading(true)
    setWorkspaceError('')

    void fetchAnnotationWorkspace(selectedAnchorEpisode)
      .then((payload) => {
        if (!active) return
        setWorkspace(payload)
        const savedAnnotations = payload.annotations.annotations || []
        annotationIdRef.current = savedAnnotations.length
        const normalizedAnnotations = savedAnnotations
          .map((item) => normalizeAnnotation(item, String(selectedAnchorEpisode)))
          .filter((item): item is AnnotationItem => item !== null)
        setAnnotations(normalizedAnnotations)
        setSelectedAnnotationId(normalizedAnnotations[0]?.id ?? null)
        setHasUnsavedChanges(false)
        setPendingRestoreContext(
          normalizeSavedComparisonContext(payload.annotations.task_context),
        )
        setSaveState({
          isSaving: false,
          error: '',
          versionNumber: payload.annotations.version_number || 0,
          savedAt:
            payload.annotations.updated_at ||
            payload.annotations.created_at ||
            '',
        })
      })
      .catch((error: Error) => {
        if (!active) return
        setWorkspace(null)
        setAnnotations([])
        setSelectedAnnotationId(null)
        setWorkspaceError(error.message)
      })
      .finally(() => {
        if (!active) return
        setWorkspaceLoading(false)
      })

    return () => {
      active = false
    }
  }, [fetchAnnotationWorkspace, selectedAnchorEpisode])

  useEffect(() => {
    setPlaybackState({ index: 0, time: 0 })
    setSelectedComparisonKey('')
    setIsStudioPaused(true)
  }, [selectedAnchorEpisode, selectedVideoPath])

  useEffect(() => {
    if (!comparisonEntries.length) {
      setSelectedComparisonKey('')
      return
    }

    setSelectedComparisonKey((currentValue) => {
      if (
        currentValue &&
        comparisonEntries.some(
          (entry) => buildComparisonSelectionKey(entry) === currentValue,
        )
      ) {
        return currentValue
      }
      const restoredKey = matchComparisonSelectionKey(
        comparisonEntries,
        pendingRestoreContext?.jointName || '',
      )
      return restoredKey || buildComparisonSelectionKey(comparisonEntries[0])
    })
  }, [comparisonEntries, pendingRestoreContext])

  useEffect(() => {
    if (!annotations.length) {
      setSelectedAnnotationId(null)
      return
    }

    if (annotations.some((annotation) => annotation.id === selectedAnnotationId)) {
      return
    }

    setSelectedAnnotationId(annotations[0].id)
  }, [annotations, selectedAnnotationId])

  useEffect(() => {
    if (!pendingRestoreContext || !effectiveSelectedVideo) return
    const playerEl = videoRef.current
    const restoreContext = pendingRestoreContext
    if (!playerEl) return
    const player = playerEl

    function applyRestore(): void {
      const relativeTime = restoreContext.timeS
      if (Number.isFinite(relativeTime)) {
        const absoluteTime = getClipStart(effectiveSelectedVideo) + Number(relativeTime)
        const boundedTime = clampToClipWindow(
          effectiveSelectedVideo,
          absoluteTime,
          Number.isFinite(player.duration) ? player.duration : Number.POSITIVE_INFINITY,
        )
        player.currentTime = boundedTime
        const timeValues = workspace?.joint_trajectory.time_values || []
        const nextIndex = timeValues.length
          ? findClosestPlaybackIndex(
              timeValues,
              Number(relativeTime) + (timeValues[0] || 0),
            )
          : 0
        setPlaybackState({
          index: nextIndex,
          time: getRelativePlaybackTime(effectiveSelectedVideo, boundedTime),
        })
      }
      setPendingRestoreContext(null)
    }

    if (player.readyState >= 1) {
      applyRestore()
      return
    }

    player.addEventListener('loadedmetadata', applyRestore, { once: true })
    return () => {
      player.removeEventListener('loadedmetadata', applyRestore)
    }
  }, [effectiveSelectedVideo, pendingRestoreContext, workspace])

  useEffect(() => {
    const playerEl = videoRef.current
    if (!playerEl || !effectiveSelectedVideo) return
    const player = playerEl

    let rafId = 0
    const timeValues = workspace?.joint_trajectory.time_values || []

    function stopPolling(): void {
      if (!rafId) return
      window.cancelAnimationFrame(rafId)
      rafId = 0
    }

    function handlePlaybackTimeChange(currentTime: number): void {
      const nextIndex = timeValues.length
        ? findClosestPlaybackIndex(timeValues, currentTime + (timeValues[0] || 0))
        : 0
      setPlaybackState({ index: nextIndex, time: currentTime })
    }

    function poll(): void {
      const boundedTime = clampToClipWindow(
        effectiveSelectedVideo,
        player.currentTime,
        player.duration,
      )
      if (Math.abs(player.currentTime - boundedTime) > CLIP_TIME_EPSILON) {
        player.currentTime = boundedTime
      }

      const clipEnd = getClipEnd(effectiveSelectedVideo)
      if (isFiniteNumber(clipEnd) && boundedTime >= clipEnd - CLIP_TIME_EPSILON) {
        if (!player.paused) player.pause()
        handlePlaybackTimeChange(
          getRelativePlaybackTime(effectiveSelectedVideo, boundedTime),
        )
        stopPolling()
        return
      }

      handlePlaybackTimeChange(
        getRelativePlaybackTime(effectiveSelectedVideo, boundedTime),
      )
      if (!player.paused && !player.ended) {
        rafId = window.requestAnimationFrame(poll)
      } else {
        rafId = 0
      }
    }

    function startPolling(): void {
      stopPolling()
      rafId = window.requestAnimationFrame(poll)
    }

    function handleLoadedMetadata(): void {
      const clipStart = getClipStart(effectiveSelectedVideo)
      const nextTime = clampToClipWindow(
        effectiveSelectedVideo,
        clipStart,
        player.duration,
      )
      if (Math.abs(player.currentTime - nextTime) > 0.1) {
        player.currentTime = nextTime
      }
      setIsStudioPaused(player.paused)
      handlePlaybackTimeChange(
        getRelativePlaybackTime(effectiveSelectedVideo, player.currentTime),
      )
    }

    function handlePlay(): void {
      setIsStudioPaused(false)
      startPolling()
    }

    function handlePause(): void {
      setIsStudioPaused(true)
      handlePlaybackTimeChange(
        getRelativePlaybackTime(effectiveSelectedVideo, player.currentTime),
      )
      stopPolling()
    }

    function handleSeeking(): void {
      const nextTime = clampToClipWindow(
        effectiveSelectedVideo,
        player.currentTime,
        player.duration,
      )
      if (Math.abs(player.currentTime - nextTime) > CLIP_TIME_EPSILON) {
        player.currentTime = nextTime
      }
      handlePlaybackTimeChange(
        getRelativePlaybackTime(effectiveSelectedVideo, player.currentTime),
      )
    }

    player.addEventListener('loadedmetadata', handleLoadedMetadata)
    player.addEventListener('play', handlePlay)
    player.addEventListener('pause', handlePause)
    player.addEventListener('ended', handlePause)
    player.addEventListener('seeking', handleSeeking)

    if (player.readyState >= 1) {
      handleLoadedMetadata()
    }

    return () => {
      stopPolling()
      player.removeEventListener('loadedmetadata', handleLoadedMetadata)
      player.removeEventListener('play', handlePlay)
      player.removeEventListener('pause', handlePause)
      player.removeEventListener('ended', handlePause)
      player.removeEventListener('seeking', handleSeeking)
    }
  }, [effectiveSelectedVideo, workspace])

  useEffect(() => {
    if (propagationRequestPendingRef.current) return
    const status = workflowState?.stages.annotation.status
    if (!propagationState.isRunning) return

    if (status === 'running') {
      propagationRunAcceptedRef.current = true
      return
    }

    if (propagationRunAcceptedRef.current) {
      propagationRunAcceptedRef.current = false
      setPropagationState((current) => ({ ...current, isRunning: false }))
    }
  }, [propagationState.isRunning, workflowState])

  function createAnnotation(seedTime = playbackState.time): void {
    if (selectedAnchorEpisode === null) return

    annotationIdRef.current += 1
    const startTime = clampAnnotationTime(seedTime, Number.POSITIVE_INFINITY)
    const fallbackLabel = `Annotation ${annotationIdRef.current}`
    const nextAnnotation = normalizeAnnotation(
      {
        id: `${selectedAnchorEpisode}-annotation-${annotationIdRef.current}`,
        label: fallbackLabel,
        text: '',
        category: 'movement',
        color:
          ANNOTATION_SEED_COLORS[
            annotationIdRef.current % ANNOTATION_SEED_COLORS.length
          ],
        startTime,
        endTime: Number((startTime + 1).toFixed(2)),
        tags: ['manual', 'language'],
        source: 'user',
      },
      String(selectedAnchorEpisode),
    )

    if (!nextAnnotation) return

    setAnnotations((current) => [...current, nextAnnotation])
    setSelectedAnnotationId(nextAnnotation.id)
    setHasUnsavedChanges(true)
  }

  function updateAnnotation(
    annotationId: string,
    patch: Partial<AnnotationItem>,
  ): void {
    setAnnotations((currentAnnotations) =>
      currentAnnotations.map((annotation) => {
        if (annotation.id !== annotationId) return annotation

        const nextText =
          patch.text !== undefined ? patch.text : annotation.text
        const nextStartTime =
          patch.startTime !== undefined
            ? Math.max(Number(patch.startTime) || 0, 0)
            : annotation.startTime
        const rawEndTime =
          patch.endTime !== undefined
            ? patch.endTime === null
              ? null
              : Math.max(Number(patch.endTime) || 0, 0)
            : annotation.endTime
        const nextEndTime =
          rawEndTime === null ? null : Math.max(rawEndTime, nextStartTime)

        return {
          ...annotation,
          ...patch,
          text: nextText,
          startTime: nextStartTime,
          endTime: nextEndTime,
          label: deriveAnnotationLabel(
            nextText,
            patch.label || annotation.label || `Annotation ${annotationId}`,
          ),
        }
      }),
    )
    setHasUnsavedChanges(true)
  }

  function deleteAnnotation(annotationId: string): void {
    setAnnotations((current) =>
      current.filter((annotation) => annotation.id !== annotationId),
    )
    setHasUnsavedChanges(true)
  }

  function jumpToTime(timeValue: number): void {
    const player = videoRef.current
    if (!player || !effectiveSelectedVideo) return

    const boundedTime = clampToClipWindow(
      effectiveSelectedVideo,
      getClipStart(effectiveSelectedVideo) +
        clampAnnotationTime(timeValue, Number.POSITIVE_INFINITY),
      player.duration,
    )
    player.currentTime = boundedTime
  }

  async function handleSaveAnnotations(): Promise<boolean> {
    if (selectedAnchorEpisode === null) return false

    setSaveState((current) => ({ ...current, isSaving: true, error: '' }))

    try {
      const saved = await saveAnnotations(selectedAnchorEpisode, taskContext, annotations)
      const normalizedAnnotations = (saved.annotations || [])
        .map((item) => normalizeAnnotation(item, String(selectedAnchorEpisode)))
        .filter((item): item is AnnotationItem => item !== null)
      annotationIdRef.current = normalizedAnnotations.length
      setAnnotations(normalizedAnnotations)
      setSelectedAnnotationId((currentValue) =>
        normalizedAnnotations.some((annotation) => annotation.id === currentValue)
          ? currentValue
          : normalizedAnnotations[0]?.id ?? null,
      )
      setSaveState({
        isSaving: false,
        error: '',
        versionNumber: saved.version_number || 0,
        savedAt: saved.updated_at || saved.created_at || '',
      })
      setHasUnsavedChanges(false)
      return true
    } catch (error) {
      setSaveState((current) => ({
        ...current,
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save annotations',
      }))
      return false
    }
  }

  async function handleRunPropagation(): Promise<void> {
    if (selectedAnchorEpisode === null) return
    if (propagationState.isRunning || propagationRequestPendingRef.current) return

    propagationRequestPendingRef.current = true
    propagationRunAcceptedRef.current = false
    setPropagationState({ isRunning: true, error: '' })

    try {
      if (hasUnsavedChanges || saveState.versionNumber === 0) {
        const saved = await handleSaveAnnotations()
        if (!saved) {
          propagationRequestPendingRef.current = false
          setPropagationState({ isRunning: false, error: '' })
          return
        }
      }

      await runPropagation(selectedAnchorEpisode)
      propagationRunAcceptedRef.current = true
      propagationRequestPendingRef.current = false
      await refreshState()
      await loadPropagationResults()
    } catch (error) {
      propagationRequestPendingRef.current = false
      propagationRunAcceptedRef.current = false
      setPropagationState({
        isRunning: false,
        error: error instanceof Error ? error.message : 'Failed to run propagation',
      })
    }
  }

  async function focusAnchorEpisode(nextEpisode: number): Promise<void> {
    if (nextEpisode === selectedAnchorEpisode) return

    if (hasUnsavedChanges) {
      const saved = await handleSaveAnnotations()
      if (!saved) return
    }

    setSelectedAnchorEpisode(nextEpisode)
  }

  if (!prototypeResults?.clusters.length) {
    return (
      <div className="annotation-panel__empty">
        <p>{copy.runPrototypeFirst}</p>
      </div>
    )
  }

  if (selectedAnchorEpisode === null) {
    return (
      <div className="annotation-panel__empty">
        <p>{copy.selectAnchor}</p>
      </div>
    )
  }

  return (
    <div className="annotation-panel">
      <div className="annotation-panel__topdock">
        <div className="annotation-panel__anchor-strip">
          <div className="annotation-panel__anchor-head">
            <div>
              <h4>{copy.anchors}</h4>
            </div>
            {hasUnsavedChanges ? (
              <span className="annotation-pill annotation-pill--warn">
                {copy.saveBeforeSwitch}
              </span>
            ) : null}
          </div>
          <div className="annotation-panel__anchor-list">
            {anchorItems.map((item) => (
              <button
                key={item.episodeIndex}
                type="button"
                className={
                  item.episodeIndex === selectedAnchorEpisode
                    ? 'annotation-anchor-card is-selected'
                    : 'annotation-anchor-card'
                }
                onClick={() => void focusAnchorEpisode(item.episodeIndex)}
              >
                <div className="annotation-anchor-card__head">
                  <span>{copy.cluster} {item.clusterIndex + 1}</span>
                  <strong>EP {item.episodeIndex}</strong>
                </div>
                <div className="annotation-anchor-card__meta">
                  <span>{copy.members}: {item.memberCount}</span>
                  <span>{copy.quality}: {item.qualityScore?.toFixed(1) ?? '-'}</span>
                </div>
                <div className="annotation-anchor-card__status">
                  {item.annotated ? (
                    <span className="annotation-pill annotation-pill--ok">
                      {copy.annotated}
                    </span>
                  ) : null}
                  <span className={item.propagated ? 'annotation-pill annotation-pill--ok' : 'annotation-pill'}>
                    {item.propagated ? copy.propagationDone : copy.propagationPending}
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="annotation-panel__toolbar">
          <div className="annotation-panel__toolbar-status">
            <span className="annotation-pill">
              {copy.savedVersion}: {saveState.versionNumber || copy.notSavedYet}
            </span>
            <span className="annotation-pill">
              {copy.annotationCount}: {annotations.length}
            </span>
            {latestPropagation ? (
              <span className="annotation-pill annotation-pill--ok">
                {copy.targetCount}: {latestPropagation.target_count}
              </span>
            ) : null}
          </div>
          <div className="annotation-panel__toolbar-actions">
            <button
              type="button"
              className="annotation-primary-button"
              onClick={() => void handleSaveAnnotations()}
              disabled={saveState.isSaving || workspaceLoading}
            >
              {saveState.isSaving ? copy.saving : copy.saveAnnotationVersion}
            </button>
            <button
              type="button"
              className="annotation-primary-button"
              onClick={() => void handleRunPropagation()}
              disabled={saveState.isSaving || workspaceLoading || propagationState.isRunning}
            >
              {propagationState.isRunning
                ? copy.propagating
                : hasUnsavedChanges || saveState.versionNumber === 0
                  ? copy.saveAndPropagate
                  : copy.runPropagation}
            </button>
          </div>
        </div>

        {workspace && workspace.videos.length > 1 ? (
          <section className="annotation-stream-switcher">
            <div className="annotation-stream-switcher__head">
              <span>{copy.switchVideo}</span>
            </div>
            <div className="annotation-stream-switcher__list">
              {workspace.videos.map((video) => (
                <button
                  key={video.path}
                  type="button"
                  className={
                    video.path === effectiveSelectedVideo?.path
                      ? 'annotation-stream-pill is-selected'
                      : 'annotation-stream-pill'
                  }
                  onClick={() => setSelectedVideoPath(video.path)}
                >
                  {video.stream || video.path}
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {workspaceError ? <div className="status-panel error">{workspaceError}</div> : null}
      {saveState.error ? <div className="status-panel error">{saveState.error}</div> : null}
      {propagationState.error ? (
        <div className="status-panel error">{propagationState.error}</div>
      ) : null}
      {workspaceLoading ? <div className="status-panel">{copy.loadingWorkspace}</div> : null}

      {workspace && !workspaceLoading ? (
        <div className="annotation-panel__studio-grid">
          <div className="annotation-panel__studio-main">
            <AnnotationWorkspaceCard
              videoRef={videoRef}
              videoSource={effectiveSelectedVideo?.url || ''}
              videoTitle={effectiveSelectedVideo?.path || ''}
              fps={Number(workspace.summary.fps) || 30}
              streamLabel={effectiveSelectedVideo?.stream || ''}
              chunkLabel={
                effectiveSelectedVideo
                  ? effectiveSelectedVideo.path.split('/').slice(-2, -1)[0] || ''
                  : ''
              }
              currentFrame={currentFrame}
              isPaused={isStudioPaused}
              videoCurrentTime={playbackState.time}
              timelineDuration={timelineDuration}
              annotations={annotations}
              selectedAnnotationId={selectedAnnotationId}
              onSelectAnnotation={setSelectedAnnotationId}
              onCreateAnnotation={createAnnotation}
              onUpdateAnnotation={updateAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onJumpToTime={jumpToTime}
            />
          </div>

          <section className="episode-preview-trajectory-panel annotation-panel__trajectory-dock">
            <div className="episode-preview-trajectory-head">
              <span>{copy.syncedAxes}</span>
              <strong>{copy.syncedAxesHint}</strong>
            </div>
            <div className="joint-comparison-focus-strip">
              <div className="joint-comparison-focus-metric">
                <span>{copy.focusJoint}</span>
                <strong>{activeComparisonEntry?.label || copy.unknownJoint}</strong>
              </div>
              <div className="joint-comparison-focus-metric">
                <span>{copy.currentCursor}</span>
                <strong>{formatSeconds(playbackState.time)}s</strong>
              </div>
              <div className="joint-comparison-focus-metric">
                <span>{copy.focusFrame}</span>
                <strong>{comparisonSnapshot.frame_index ?? '-'}</strong>
              </div>
              <div className="joint-comparison-focus-metric">
                <span>{copy.focusActionValue}</span>
                <strong>{formatValue(comparisonSnapshot.action_value)}</strong>
              </div>
              <div className="joint-comparison-focus-metric">
                <span>{copy.focusStateValue}</span>
                <strong>{formatValue(comparisonSnapshot.state_value)}</strong>
              </div>
            </div>
            <JointComparisonWorkbench
              jointTrajectory={workspace.joint_trajectory}
              currentTime={playbackState.time}
              copy={{
                noJointData: copy.noJointData,
                actionSeries: copy.actionSeries,
                stateSeries: copy.stateSeries,
                focusActionValue: copy.focusActionValue,
                focusStateValue: copy.focusStateValue,
              }}
              activeKey={selectedComparisonKey}
              onSelectEntry={setSelectedComparisonKey}
            />
          </section>
        </div>
      ) : null}
    </div>
  )
}
