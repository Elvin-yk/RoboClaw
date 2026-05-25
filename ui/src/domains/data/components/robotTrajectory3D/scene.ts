import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { URDFRobot } from 'urdf-loader'
import { clamp, relativeTimeValues } from '@/domains/data/lib/analysisPayload'
import type { EpisodeRobotTrajectory, RobotArmSide, RobotModelManifest } from '@/domains/data/model/types'
import { loadRobotUrdf } from './urdf'

const DEG_TO_RAD = Math.PI / 180

const ARM_COLORS: Record<RobotArmSide, string> = {
  left: '#4f8fbd',
  right: '#d0892b',
}
const DEFAULT_CAMERA_POSITION = [-1.05, 0, 0.44] as const
const DEFAULT_CAMERA_TARGET = [0, 0, -0.08] as const
const FLOOR_SIZE = 1.8
const FLOOR_DIVISIONS = 18

interface ArmInstance {
  robot: URDFRobot
}

interface TrajectoryFrameCache {
  payload: EpisodeRobotTrajectory
  times: number[]
}

export class RobotTrajectory3DScene {
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly arms = new Map<RobotArmSide, ArmInstance>()
  private frameCache: TrajectoryFrameCache | null = null
  private disposed = false

  constructor(private readonly container: HTMLDivElement) {
    const width = container.clientWidth || 800
    const height = container.clientHeight || 420
    this.scene.background = new THREE.Color(0xf3f6fa)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.04, 40)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(...DEFAULT_CAMERA_POSITION)
    this.camera.lookAt(...DEFAULT_CAMERA_TARGET)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height)
    container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(...DEFAULT_CAMERA_TARGET)
    this.controls.enableDamping = true
    this.controls.update()

    this.scene.add(buildLights())
    this.scene.add(buildFloor())
    this.scene.add(new THREE.AxesHelper(0.12))

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.renderer.setAnimationLoop(() => this.render())
  }

  async loadArms(model: RobotModelManifest): Promise<void> {
    await Promise.all([
      this.loadArm('left', model),
      this.loadArm('right', model),
    ])
  }

  applyTime(payload: EpisodeRobotTrajectory, model: RobotModelManifest, currentTime: number): void {
    if (!this.arms.size || payload.frame_count <= 0) return
    const frame = frameForTime(this.relativeTimes(payload), currentTime)
    for (const side of ['left', 'right'] as const) {
      const arm = this.arms.get(side)
      if (!arm) continue
      const series = payload.arms[side].joint_degrees
      for (const joint of model.joint_order) {
        const value = interpolatedValue(series[joint] || [], frame.index, frame.nextIndex, frame.alpha)
        if (value == null) continue
        arm.robot.setJointValue(joint, value * DEG_TO_RAD)
      }
      arm.robot.updateMatrixWorld(true)
    }
  }

  dispose(): void {
    this.disposed = true
    this.renderer.setAnimationLoop(null)
    this.resizeObserver.disconnect()
    this.controls.dispose()
    disposeObject(this.scene)
    this.scene.clear()
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  private async loadArm(side: RobotArmSide, model: RobotModelManifest): Promise<void> {
    if (this.disposed || this.arms.has(side)) return
    const root = new THREE.Group()
    root.position.fromArray(side === 'left' ? model.scene.left_base_xyz : model.scene.right_base_xyz)
    this.scene.add(root)
    const robot = await loadRobotUrdf(model.urdf_url, { meshColor: ARM_COLORS[side] })
    if (this.disposed) {
      disposeObject(robot)
      return
    }
    root.add(robot)
    this.arms.set(side, { robot })
  }

  private resize(): void {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (width <= 0 || height <= 0) return
    this.camera.aspect = width / height
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(width, height)
  }

  private render(): void {
    this.controls.update()
    this.renderer.render(this.scene, this.camera)
  }

  private relativeTimes(payload: EpisodeRobotTrajectory): number[] {
    if (this.frameCache?.payload !== payload) {
      this.frameCache = {
        payload,
        times: relativeTimeValues(payload.time_s),
      }
    }
    return this.frameCache.times
  }
}

function frameForTime(times: number[], currentTime: number): {
  index: number
  nextIndex: number
  alpha: number
} {
  if (!times.length || currentTime <= times[0]) return { index: 0, nextIndex: 0, alpha: 0 }
  const lastIndex = times.length - 1
  if (currentTime >= times[lastIndex]) return { index: lastIndex, nextIndex: lastIndex, alpha: 0 }
  let low = 1
  let high = lastIndex
  while (low < high) {
    const midpoint = Math.floor((low + high) / 2)
    if (currentTime > times[midpoint]) {
      low = midpoint + 1
    } else {
      high = midpoint
    }
  }
  const previous = times[low - 1]
  const next = times[low]
  const span = Math.max(next - previous, Number.EPSILON)
  return { index: low - 1, nextIndex: low, alpha: clamp((currentTime - previous) / span, 0, 1) }
}

function interpolatedValue(
  values: Array<number | null>,
  index: number,
  nextIndex: number,
  alpha: number,
): number | null {
  const current = values[index]
  if (current == null) return null
  const next = values[nextIndex]
  if (next == null || nextIndex === index) return current
  return current + (next - current) * clamp(alpha, 0, 1)
}

function buildLights(): THREE.Group {
  const group = new THREE.Group()
  const ambient = new THREE.AmbientLight(0xffffff, 0.62)
  const key = new THREE.DirectionalLight(0xffffff, 0.78)
  const fill = new THREE.DirectionalLight(0xffffff, 0.38)
  key.position.set(0.8, 0.7, 1.6)
  fill.position.set(-0.6, -0.5, 0.7)
  group.add(ambient, key, fill)
  return group
}

function buildFloor(): THREE.Group {
  const group = new THREE.Group()
  const geometry = new THREE.PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE)
  const material = new THREE.MeshStandardMaterial({
    color: 0x70757a,
    roughness: 0.94,
    metalness: 0,
    side: THREE.DoubleSide,
  })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.z = -0.006

  const grid = new THREE.GridHelper(FLOOR_SIZE, FLOOR_DIVISIONS, 0x252a30, 0x444a50)
  grid.rotation.x = Math.PI / 2
  grid.position.z = 0.001

  group.add(mesh, grid)
  return group
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const resource = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry
      material?: THREE.Material | THREE.Material[]
    }
    resource.geometry?.dispose()
    const material = resource.material
    if (!material) return
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose())
      return
    }
    material.dispose()
  })
}
