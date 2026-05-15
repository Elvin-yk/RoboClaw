import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { URDFRobot } from 'urdf-loader'
import type { EpisodeRobotTrajectory, RobotArmSide, RobotModelManifest } from '@/domains/data/model/types'
import { loadRobotUrdf } from './urdf'

const DEG_TO_RAD = Math.PI / 180

const ARM_COLORS: Record<RobotArmSide, string> = {
  left: '#4f8fbd',
  right: '#d0892b',
}

interface ArmInstance {
  robot: URDFRobot
}

export class RobotTrajectory3DScene {
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly renderer: THREE.WebGLRenderer
  private readonly controls: OrbitControls
  private readonly resizeObserver: ResizeObserver
  private readonly arms = new Map<RobotArmSide, ArmInstance>()
  private disposed = false

  constructor(private readonly container: HTMLDivElement) {
    const width = container.clientWidth || 800
    const height = container.clientHeight || 420
    this.scene.background = new THREE.Color(0xf3f6fa)
    this.camera = new THREE.PerspectiveCamera(45, width / height, 0.04, 40)
    this.camera.up.set(0, 0, 1)
    this.camera.position.set(0.62, 0.62, 0.42)
    this.camera.lookAt(0, 0, 0.16)

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    this.renderer.setSize(width, height)
    container.appendChild(this.renderer.domElement)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(0, 0, 0.16)
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
    const frame = frameForTime(payload, currentTime)
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
}

function frameForTime(payload: EpisodeRobotTrajectory, currentTime: number): {
  index: number
  nextIndex: number
  alpha: number
} {
  const times = relativeTimes(payload.time_s)
  if (!times.length || currentTime <= times[0]) return { index: 0, nextIndex: 0, alpha: 0 }
  const lastIndex = times.length - 1
  if (currentTime >= times[lastIndex]) return { index: lastIndex, nextIndex: lastIndex, alpha: 0 }
  for (let index = 1; index < times.length; index += 1) {
    if (currentTime > times[index]) continue
    const previous = times[index - 1]
    const next = times[index]
    const span = Math.max(next - previous, Number.EPSILON)
    return { index: index - 1, nextIndex: index, alpha: (currentTime - previous) / span }
  }
  return { index: lastIndex, nextIndex: lastIndex, alpha: 0 }
}

function relativeTimes(values: number[]): number[] {
  const start = values[0] ?? 0
  return values.map((value, index) => Number.isFinite(value) ? value - start : index)
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
  return current + (next - current) * Math.max(0, Math.min(1, alpha))
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

function buildFloor(): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(1.5, 1.5)
  const material = new THREE.MeshStandardMaterial({ color: 0xe6ebf2, roughness: 0.92 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.position.z = -0.001
  return mesh
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const material = mesh.material
    if (Array.isArray(material)) {
      material.forEach((item) => item.dispose())
      return
    }
    material?.dispose()
  })
}
