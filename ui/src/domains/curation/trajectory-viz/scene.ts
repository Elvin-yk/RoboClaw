/** Imperative Three.js scene for the SO101 dual-arm trajectory viewer. */

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import URDFLoader from 'urdf-loader'
import type { URDFRobot } from 'urdf-loader'

import type { So101Model, Side, TrajectoryPayload } from './types'

const DEG_TO_RAD = Math.PI / 180

interface ArmInstance {
    side: Side
    root: THREE.Group
    robot: URDFRobot
    eeLink: THREE.Object3D | null
}

export interface ArmFrameSample {
    side: Side
    jointDegrees: Record<string, number>
    eeWorld: THREE.Vector3
}

export class DualArmScene {
    readonly scene = new THREE.Scene()
    readonly camera: THREE.PerspectiveCamera
    readonly renderer: THREE.WebGLRenderer
    private controls: OrbitControls
    private arms = new Map<Side, ArmInstance>()
    private model: So101Model | null = null
    private resizeObserver: ResizeObserver | null = null
    private disposed = false

    constructor(private container: HTMLDivElement) {
        const width = container.clientWidth || 800
        const height = container.clientHeight || 600
        this.scene.background = new THREE.Color(0xf3f4f6)

        this.camera = new THREE.PerspectiveCamera(45, width / height, 0.05, 50)
        this.camera.up.set(0, 0, 1)
        this.camera.position.set(0.6, 0.6, 0.4)
        this.camera.lookAt(0, 0, 0.15)

        this.renderer = new THREE.WebGLRenderer({ antialias: true })
        this.renderer.setPixelRatio(window.devicePixelRatio)
        this.renderer.setSize(width, height)
        container.appendChild(this.renderer.domElement)

        this.controls = new OrbitControls(this.camera, this.renderer.domElement)
        this.controls.target.set(0, 0, 0.15)
        this.controls.update()

        this.scene.add(buildLights())
        this.scene.add(buildFloor())
        this.scene.add(new THREE.AxesHelper(0.1))

        this.resizeObserver = new ResizeObserver(() => this.handleResize())
        this.resizeObserver.observe(container)

        this.renderer.setAnimationLoop(this.renderLoop)
    }

    async loadArm(side: Side, model: So101Model): Promise<void> {
        if (this.disposed || this.arms.has(side)) return
        this.model = model
        const root = new THREE.Group()
        root.position.fromArray(side === 'left' ? model.scene.left_base_xyz : model.scene.right_base_xyz)
        this.scene.add(root)

        const robot = await loadUrdf(model.urdf_url)
        // Mount may have unmounted while STL meshes were loading; bail out
        // before mutating this.arms / this.scene to avoid leaks.
        if (this.disposed) return
        root.add(robot)
        const eeLink = (robot.links && robot.links[model.ee_link]) || null
        this.arms.set(side, { side, root, robot, eeLink })
    }

    async loadArms(model: So101Model): Promise<void> {
        await Promise.all([this.loadArm('left', model), this.loadArm('right', model)])
    }

    /** Apply the joint values for `frame` (interpolated to `frame+1` by `alpha`). */
    applyFrame(payload: TrajectoryPayload, frame: number, alpha: number): ArmFrameSample[] {
        const samples: ArmFrameSample[] = []
        if (!this.model) return samples
        const lastFrame = payload.frame_count - 1
        const safeFrame = Math.max(0, Math.min(lastFrame, frame))
        const nextFrame = Math.min(lastFrame, safeFrame + 1)
        const blend = nextFrame === safeFrame ? 0 : Math.max(0, Math.min(1, alpha))

        for (const arm of this.arms.values()) {
            const series = payload.arms[arm.side].joint_degrees
            const jointDegrees: Record<string, number> = {}
            for (const joint of this.model.joint_order) {
                const arr = series[joint]
                if (!arr) continue
                const a = arr[safeFrame]
                const b = arr[nextFrame]
                const deg = a + (b - a) * blend
                jointDegrees[joint] = deg
                arm.robot.setJointValue(joint, deg * DEG_TO_RAD)
            }
            arm.robot.updateMatrixWorld(true)
            const eeWorld = new THREE.Vector3()
            if (arm.eeLink) arm.eeLink.getWorldPosition(eeWorld)
            samples.push({ side: arm.side, jointDegrees, eeWorld })
        }
        return samples
    }

    dispose(): void {
        this.disposed = true
        this.renderer.setAnimationLoop(null)
        this.resizeObserver?.disconnect()
        this.controls.dispose()
        this.renderer.dispose()
        if (this.renderer.domElement.parentNode) {
            this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
        }
        this.scene.clear()
    }

    private handleResize(): void {
        const w = this.container.clientWidth
        const h = this.container.clientHeight
        if (w === 0 || h === 0) return
        this.camera.aspect = w / h
        this.camera.updateProjectionMatrix()
        this.renderer.setSize(w, h)
    }

    private renderLoop = (): void => {
        this.controls.update()
        this.renderer.render(this.scene, this.camera)
    }
}

function loadUrdf(url: string): Promise<URDFRobot> {
    return new Promise((resolve, reject) => {
        const manager = new THREE.LoadingManager()
        const loader = new URDFLoader(manager)
        loader.loadMeshCb = (path, _manager, done) => {
            new STLLoader().load(
                path,
                (geometry) => {
                    const mesh = new THREE.Mesh(
                        geometry,
                        new THREE.MeshStandardMaterial({ color: 0xb6b6b6, metalness: 0.2, roughness: 0.7 }),
                    )
                    done(mesh)
                },
                undefined,
                reject,
            )
        }
        loader.load(url, resolve, undefined, reject)
    })
}

function buildLights(): THREE.Group {
    const group = new THREE.Group()
    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(1, 1, 2)
    group.add(ambient)
    group.add(dir)
    return group
}

function buildFloor(): THREE.Mesh {
    const geom = new THREE.PlaneGeometry(2, 2)
    const mat = new THREE.MeshStandardMaterial({ color: 0xe5e7eb, roughness: 0.95 })
    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.z = -0.001
    return mesh
}

export interface FrameMetricsSample {
    left: ArmFrameSample | null
    right: ArmFrameSample | null
    relative: { dx: number; dy: number; dz: number; distance: number } | null
}

export function buildFrameMetrics(samples: ArmFrameSample[]): FrameMetricsSample {
    const left = samples.find((s) => s.side === 'left') ?? null
    const right = samples.find((s) => s.side === 'right') ?? null
    const relative = left && right
        ? {
            dx: right.eeWorld.x - left.eeWorld.x,
            dy: right.eeWorld.y - left.eeWorld.y,
            dz: right.eeWorld.z - left.eeWorld.z,
            distance: right.eeWorld.distanceTo(left.eeWorld),
        }
        : null
    return { left, right, relative }
}
