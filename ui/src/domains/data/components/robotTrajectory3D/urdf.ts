import * as THREE from 'three'
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js'
import URDFLoader, { type URDFRobot } from 'urdf-loader'

interface LoadRobotUrdfOptions {
  meshColor: THREE.ColorRepresentation
}

export function loadRobotUrdf(url: string, options: LoadRobotUrdfOptions): Promise<URDFRobot> {
  return new Promise((resolve, reject) => {
    const manager = new THREE.LoadingManager()
    const loader = new URDFLoader(manager)
    loader.loadMeshCb = (path, _manager, done) => {
      new STLLoader().load(
        path,
        (geometry) => {
          const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
              color: options.meshColor,
              metalness: 0.18,
              roughness: 0.72,
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
