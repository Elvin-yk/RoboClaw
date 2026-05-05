export interface JointLimitDeg {
    lower_deg: number
    upper_deg: number
}

export interface SceneSpec {
    arm_separation_m: number
    left_base_xyz: [number, number, number]
    right_base_xyz: [number, number, number]
    forward_axis: string
    lateral_axis: string
    up_axis: string
}

export interface So101Model {
    model: string
    urdf_url: string
    asset_base_url: string
    ee_link: string
    joint_order: string[]
    joint_unit: string
    joint_limits_deg: Record<string, JointLimitDeg>
    scene: SceneSpec
}

export interface ArmTrajectory {
    joint_degrees: Record<string, number[]>
}

export interface QualityFlag {
    frame: number
    arm: 'left' | 'right'
    joint: string
    code: string
    value: number
}

export interface TrajectoryPayload {
    dataset: string
    source: 'local' | 'path'
    episode_index: number
    signal: 'state' | 'action'
    fps: number
    frame_count: number
    duration_s: number
    time_s: number[]
    frame_index: number[]
    units: { arm_joints: string; gripper: string }
    arms: { left: ArmTrajectory; right: ArmTrajectory }
    quality_flags: QualityFlag[]
}

export type Side = 'left' | 'right'
export type Signal = 'state' | 'action'

export interface TrajectoryDatasetOption {
    id: string
    label?: string
    path?: string
    source: 'local'
    source_kind?: string
}

export interface TrajectoryDatasetRef {
    source: 'local' | 'path'
    dataset?: string
    path?: string
    label?: string
}

export interface TrajectoryEpisodeSummary {
    episode_index: number
    length: number
}

export interface TrajectoryEpisodePage {
    dataset: string
    page: number
    page_size: number
    total_episodes: number
    total_pages: number
    episodes: TrajectoryEpisodeSummary[]
}

export interface ArmReadout {
    jointDegrees: Record<string, number>
    eeWorldM: [number, number, number] | null
}

export interface TrajectoryMetrics {
    frame: number
    rawFrame: number | null
    timeSec: number
    left: ArmReadout
    right: ArmReadout
    eeRelativeM: { dx: number; dy: number; dz: number; distance: number } | null
}
