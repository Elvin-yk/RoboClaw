/** Headless dual-arm forward kinematics for the SO101 model.
 *
 * Loads its own URDF instances (one per side) WITHOUT visual meshes so the
 * compute path stays independent from the rendered scene. Each robot is
 * wrapped in a THREE.Group that carries the per-arm base offset, mirroring
 * the layout used by `DualArmScene`.
 */

import * as THREE from 'three'
import type { URDFRobot } from 'urdf-loader'

import type { Side, So101Model, TrajectoryPayload } from './types'
import { loadSo101Urdf } from './urdf'

const DEG_TO_RAD = Math.PI / 180

interface ArmFkInstance {
    side: Side
    root: THREE.Group
    robot: URDFRobot
    eeLink: THREE.Object3D
}

export interface ComputeDistanceSeriesOptions {
    signal?: AbortSignal
    chunkSize?: number
    onProgress?: (done: number, total: number) => void
}

export class DualArmKinematics {
    private model: So101Model | null = null
    private arms = new Map<Side, ArmFkInstance>()
    private leftEe = new THREE.Vector3()
    private rightEe = new THREE.Vector3()
    private loadPromise: Promise<void> | null = null

    load(model: So101Model): Promise<void> {
        this.model = model
        const sides: Side[] = ['left', 'right']
        this.loadPromise = Promise.all(sides.map((side) => this.loadArm(side, model))).then(() => undefined)
        return this.loadPromise
    }

    /** Wait until both URDFs have finished parsing. Resolves immediately if already loaded. */
    async ready(): Promise<void> {
        if (!this.loadPromise) {
            throw new Error('DualArmKinematics.load() must be called before ready()')
        }
        await this.loadPromise
    }

    distanceAtFrame(payload: TrajectoryPayload, frame: number): number {
        if (!this.model) {
            throw new Error('DualArmKinematics.load must complete before measuring distance')
        }
        const left = this.arms.get('left')
        const right = this.arms.get('right')
        if (!left || !right) {
            throw new Error('DualArmKinematics: both arms must be loaded')
        }
        const lastFrame = payload.frame_count - 1
        const safeFrame = Math.max(0, Math.min(lastFrame, frame))
        for (const arm of this.arms.values()) {
            const series = payload.arms[arm.side].joint_degrees
            for (const joint of this.model.joint_order) {
                const arr = series[joint]
                if (!arr) continue
                arm.robot.setJointValue(joint, arr[safeFrame] * DEG_TO_RAD)
            }
            arm.root.updateMatrixWorld(true)
        }
        left.eeLink.getWorldPosition(this.leftEe)
        right.eeLink.getWorldPosition(this.rightEe)
        return this.leftEe.distanceTo(this.rightEe)
    }

    async computeDistanceSeries(
        payload: TrajectoryPayload,
        opts: ComputeDistanceSeriesOptions = {},
    ): Promise<Float32Array> {
        await this.ready()
        const total = payload.frame_count
        const chunkSize = opts.chunkSize ?? 256
        const out = new Float32Array(total)
        for (let start = 0; start < total; start += chunkSize) {
            if (opts.signal?.aborted) {
                throw new DOMException('aborted', 'AbortError')
            }
            const end = Math.min(total, start + chunkSize)
            for (let i = start; i < end; i += 1) {
                out[i] = this.distanceAtFrame(payload, i)
            }
            opts.onProgress?.(end, total)
            // Yield to the event loop so playback / UI stay responsive.
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }
        return out
    }

    dispose(): void {
        this.arms.clear()
        this.model = null
        this.loadPromise = null
    }

    private async loadArm(side: Side, model: So101Model): Promise<void> {
        const root = new THREE.Group()
        root.position.fromArray(side === 'left' ? model.scene.left_base_xyz : model.scene.right_base_xyz)
        const robot = await loadSo101Urdf(model.urdf_url, { loadVisualMeshes: false })
        root.add(robot)
        const eeLink = robot.links?.[model.ee_link]
        if (!eeLink) {
            throw new Error(`DualArmKinematics: URDF is missing ee_link '${model.ee_link}'`)
        }
        this.arms.set(side, { side, root, robot, eeLink })
    }
}
