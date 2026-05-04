import { create } from 'zustand'
import { postJson } from '@/shared/api/client'

const RECOVERY = '/api/recovery'
const RUNTIME_INFO = '/api/system/runtime-info'

export const RECOVERY_FAULT_TYPES = {
  ARM_DISCONNECTED: 'arm_disconnected',
  ARM_MOTOR_DISCONNECTED: 'arm_motor_disconnected',
  ARM_TIMEOUT: 'arm_timeout',
  ARM_NOT_CALIBRATED: 'arm_not_calibrated',
  CAMERA_DISCONNECTED: 'camera_disconnected',
  CAMERA_FRAME_DROP: 'camera_frame_drop',
  RECORD_CRASHED: 'record_crashed',
} as const

export type RecoveryFaultType = typeof RECOVERY_FAULT_TYPES[keyof typeof RECOVERY_FAULT_TYPES]

export interface RecoveryFault {
  fault_type: RecoveryFaultType
  device_alias: string
  message: string
  timestamp: number
}

export function recoveryFaultKey(faultType: RecoveryFaultType, deviceAlias: string) {
  return `${faultType}:${deviceAlias}`
}

interface RecoveryStore {
  faults: RecoveryFault[]
  hasCheckedHardware: boolean
  checkingHardware: boolean
  restarting: boolean
  checkHardware: () => Promise<void>
  restartDashboard: () => Promise<void>
}

async function waitForDashboardRecovery(timeoutMs: number = 30000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 1000))
    try {
      const response = await fetch(RUNTIME_INFO, { cache: 'no-store' })
      if (response.ok) {
        window.location.reload()
        return
      }
    } catch {
      // Dashboard still restarting; keep polling until timeout.
    }
  }
  throw new Error('Dashboard restart timed out')
}

export const useRecoveryStore = create<RecoveryStore>((set) => ({
  faults: [],
  hasCheckedHardware: false,
  checkingHardware: false,
  restarting: false,

  checkHardware: async () => {
    set({ checkingHardware: true })
    try {
      const data = await postJson(`${RECOVERY}/check-hardware`)
      set({
        faults: Array.isArray(data.faults) ? data.faults : [],
        hasCheckedHardware: true,
      })
    } finally {
      set({ checkingHardware: false })
    }
  },

  restartDashboard: async () => {
    set({ restarting: true })
    try {
      await postJson(`${RECOVERY}/restart-dashboard`)
      await waitForDashboardRecovery()
    } finally {
      set({ restarting: false })
    }
  },
}))
