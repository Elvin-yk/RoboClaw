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

interface RobotTrajectory3DPanelProps {
  source: RobotTrajectorySource
  dataset?: string
  path?: string
  episodeIndex: number
  currentTime: number
  signal: RobotTrajectorySignal
  onSignalChange: (signal: RobotTrajectorySignal) => void
}

export function RobotTrajectory3DPanel({
  source,
  dataset,
  path,
  episodeIndex,
  currentTime,
  signal,
  onSignalChange,
}: RobotTrajectory3DPanelProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const sceneRef = useRef<RobotTrajectory3DScene | null>(null)
  const currentTimeRef = useRef(currentTime)
  const [model, setModel] = useState<RobotModelManifest | null>(null)
  const [trajectory, setTrajectory] = useState<EpisodeRobotTrajectory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const canLoad = source !== 'remote' && (source === 'path' ? Boolean(path) : Boolean(dataset))

  useEffect(() => {
    currentTimeRef.current = currentTime
  }, [currentTime])

  useEffect(() => {
    if (!canLoad) {
      setModel(null)
      setTrajectory(null)
      setLoading(false)
      setError('')
      return undefined
    }
    let active = true
    setLoading(true)
    setError('')
    void Promise.all([
      dataApi.robotModel(ROBOT_MODEL),
      dataApi.episodeRobotTrajectory({
        dataset: dataset || undefined,
        source,
        path,
        episode_index: episodeIndex,
        signal,
        model: ROBOT_MODEL,
      }),
    ]).then(([nextModel, nextTrajectory]) => {
      if (!active) return
      setModel(nextModel)
      setTrajectory(nextTrajectory)
      setLoading(false)
    }).catch((loadError: unknown) => {
      if (!active) return
      setModel(null)
      setTrajectory(null)
      setError(loadError instanceof Error ? loadError.message : String(loadError))
      setLoading(false)
    })
    return () => {
      active = false
    }
  }, [canLoad, dataset, episodeIndex, path, signal, source])

  useEffect(() => {
    const container = containerRef.current
    if (!container || !model || !trajectory) return undefined
    let active = true
    const scene = new RobotTrajectory3DScene(container)
    sceneRef.current = scene
    setError('')
    void scene.loadArms(model).then(() => {
      if (!active) return
      scene.applyTime(trajectory, model, currentTimeRef.current)
    }).catch((sceneError: unknown) => {
      if (!active) return
      setError(sceneError instanceof Error ? sceneError.message : String(sceneError))
    })
    return () => {
      active = false
      sceneRef.current = null
      scene.dispose()
    }
  }, [model, trajectory])

  useEffect(() => {
    if (!sceneRef.current || !model || !trajectory) return
    sceneRef.current.applyTime(trajectory, model, currentTime)
  }, [currentTime, model, trajectory])

  if (!canLoad) return null

  return (
    <section className="data-robot-trajectory3d">
      <div className="data-robot-trajectory3d__head">
        <h3>3D</h3>
        <div className="data-robot-trajectory3d__signals" role="group" aria-label="3D trajectory signal">
          <button
            type="button"
            className={cn(signal === 'action' && 'is-active')}
            onClick={() => onSignalChange('action')}
          >
            Action
          </button>
          <button
            type="button"
            className={cn(signal === 'state' && 'is-active')}
            onClick={() => onSignalChange('state')}
          >
            State
          </button>
        </div>
      </div>
      <div className="data-robot-trajectory3d__viewport" ref={containerRef}>
        {loading && <div className="data-robot-trajectory3d__overlay">加载 3D</div>}
        {error && <div className="data-robot-trajectory3d__overlay is-error">3D 资源不可用</div>}
      </div>
    </section>
  )
}
