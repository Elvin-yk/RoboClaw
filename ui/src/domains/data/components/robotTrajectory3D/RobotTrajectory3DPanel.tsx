import { useEffect, useRef, useState } from 'react'
import { dataApi } from '@/domains/data/api/dataApi'
import type {
  EpisodeRobotTrajectory,
  RobotModelManifest,
  RobotTrajectorySignal,
  RobotTrajectorySource,
} from '@/domains/data/model/types'
import { cn } from '@/shared/lib/cn'
import { RobotTrajectory3DScene } from './scene'

const ROBOT_MODEL = 'so101'
const SIGNAL_OPTIONS: { value: RobotTrajectorySignal; label: string }[] = [
  { value: 'action', label: 'Action' },
  { value: 'state', label: 'Observation' },
]

interface RobotTrajectory3DPanelProps {
  source: RobotTrajectorySource
  dataset?: string
  path?: string
  episodeIndex: number
  currentTime: number
  allowStaticModel?: boolean
}

export function RobotTrajectory3DPanel({
  source,
  dataset,
  path,
  episodeIndex,
  currentTime,
  allowStaticModel = false,
}: RobotTrajectory3DPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<RobotTrajectory3DScene | null>(null)
  const currentTimeRef = useRef(currentTime)
  const trajectoryRef = useRef<EpisodeRobotTrajectory | null>(null)
  const [signal, setSignal] = useState<RobotTrajectorySignal>('action')
  const [model, setModel] = useState<RobotModelManifest | null>(null)
  const [trajectory, setTrajectory] = useState<EpisodeRobotTrajectory | null>(null)
  const [modelLoading, setModelLoading] = useState(false)
  const [trajectoryLoading, setTrajectoryLoading] = useState(false)
  const [modelError, setModelError] = useState('')
  const [trajectoryError, setTrajectoryError] = useState('')
  const [sceneError, setSceneError] = useState('')
  const canLoad = source !== 'remote' && (source === 'path' ? Boolean(path) : Boolean(dataset))
  const loading = modelLoading || trajectoryLoading
  const error = modelError || sceneError || (allowStaticModel ? '' : trajectoryError)

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    trajectoryRef.current = trajectory
  }, [trajectory])

  useEffect(() => {
    let active = true
    setModelLoading(true)
    setModelError('')
    void dataApi.robotModel(ROBOT_MODEL).then((nextModel) => {
      if (!active) return
      setModel(nextModel)
      setModelLoading(false)
    }).catch((loadError: unknown) => {
      if (!active) return
      setModel(null)
      setModelError(loadError instanceof Error ? loadError.message : String(loadError))
      setModelLoading(false)
    })
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!canLoad) {
      setTrajectory(null)
      setTrajectoryLoading(false)
      setTrajectoryError('')
      return undefined
    }
    let active = true
    setTrajectoryLoading(true)
    setTrajectoryError('')
    void dataApi.episodeRobotTrajectory({
      dataset: dataset || undefined,
      source,
      path,
      episode_index: episodeIndex,
      signal,
      model: ROBOT_MODEL,
    }).then((nextTrajectory) => {
      if (!active) return
      setTrajectory(nextTrajectory)
      setTrajectoryLoading(false)
    }).catch((loadError: unknown) => {
      if (!active) return
      setTrajectory(null)
      setTrajectoryError(loadError instanceof Error ? loadError.message : String(loadError))
      setTrajectoryLoading(false)
    })
    return () => {
      active = false
    }
  }, [canLoad, dataset, episodeIndex, path, signal, source])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !model) return undefined
    let active = true
    const scene = new RobotTrajectory3DScene(container)
    sceneRef.current = scene
    setSceneError('')
    void scene.loadArms(model).then(() => {
      if (!active) return
      if (trajectoryRef.current) {
        scene.applyTime(trajectoryRef.current, model, currentTimeRef.current)
      }
    }).catch((sceneError: unknown) => {
      if (!active) return
      setSceneError(sceneError instanceof Error ? sceneError.message : String(sceneError))
    })
    return () => {
      active = false
      sceneRef.current = null
      scene.dispose()
    }
  }, [model])

  useEffect(() => {
    if (!sceneRef.current || !model || !trajectory) return
    sceneRef.current.applyTime(trajectory, model, currentTime)
  }, [currentTime, model, trajectory])

  if (!canLoad) return null

  return (
    <section className="data-analysis-section">
      <div className="data-robot-trajectory3d__header">
        <div className="data-analysis-section-title">机械臂 3D 轨迹</div>
        <div className="data-robot-trajectory3d__signal" role="group" aria-label="轨迹信号源">
          {SIGNAL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={cn(
                'data-robot-trajectory3d__signal-option',
                signal === option.value && 'is-active',
              )}
              aria-pressed={signal === option.value}
              onClick={() => setSignal(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="data-robot-trajectory3d">
        <div className="data-robot-trajectory3d__viewport" ref={containerRef}>
          {loading && <div className="data-robot-trajectory3d__overlay">加载 3D</div>}
          {error && <div className="data-robot-trajectory3d__overlay is-error">3D 资源不可用</div>}
        </div>
      </div>
    </section>
  )
}
