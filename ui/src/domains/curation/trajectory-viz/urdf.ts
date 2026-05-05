/** Shared SO101 URDF loader used by both the visible scene and the headless
 * forward-kinematics evaluator.
 *
 * `loadVisualMeshes: false` is the cheap-FK path — the URDF parser still
 * resolves the joint/link tree, but each `<mesh>` reference is satisfied with
 * an empty THREE.Group placeholder, so STL downloads and parsing are skipped
 * entirely. That keeps `DualArmKinematics` independent from GPU resources and
 * cheap to spin up alongside the visible scene.
 */

import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import URDFLoader from 'urdf-loader'
import type { URDFRobot } from 'urdf-loader'

export interface LoadSo101UrdfOptions {
    meshColor?: THREE.ColorRepresentation
    loadVisualMeshes?: boolean
}

export function loadSo101Urdf(
    url: string,
    options: LoadSo101UrdfOptions = {},
): Promise<URDFRobot> {
    const loadVisualMeshes = options.loadVisualMeshes ?? true
    const meshColor = options.meshColor ?? 0xb6b6b6
    return new Promise((resolve, reject) => {
        const manager = new THREE.LoadingManager()
        const loader = new URDFLoader(manager)
        loader.loadMeshCb = (path, _manager, done) => {
            if (!loadVisualMeshes) {
                done(new THREE.Group())
                return
            }
            new STLLoader().load(
                path,
                (geometry) => {
                    const mesh = new THREE.Mesh(
                        geometry,
                        new THREE.MeshStandardMaterial({
                            color: meshColor,
                            metalness: 0.2,
                            roughness: 0.7,
                        }),
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
