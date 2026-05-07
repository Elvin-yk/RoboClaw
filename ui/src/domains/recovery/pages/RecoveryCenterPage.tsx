import { useEffect, useMemo } from 'react'
import { useToast } from '@/app/shell/ToastOutlet'
import { CameraPreviewPanel } from '@/domains/control/components/CameraPreviewPanel'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import {
  RECOVERY_FAULT_TYPES,
  recoveryFaultKey,
  type RecoveryFault,
  type RecoveryFaultType,
  useRecoveryStore,
} from '@/domains/recovery/store/useRecoveryStore'
import { useSetup } from '@/domains/hardware/setup/store/useSetupStore'
import { useI18n } from '@/i18n'

type HardwareRow = {
  key: string
  kind: 'arm' | 'camera'
  alias: string
  badge: string
}

type PrimaryFault = {
  key: string
  alias: string
  badge: string
  title: string
  message: string
}

export default function RecoveryCenterPage() {
  const { t } = useI18n()
  const toast = useToast((state) => state.add)
  const faults = useRecoveryStore((state) => state.faults)
  const hasCheckedHardware = useRecoveryStore((state) => state.hasCheckedHardware)
  const checkingHardware = useRecoveryStore((state) => state.checkingHardware)
  const restarting = useRecoveryStore((state) => state.restarting)
  const checkHardware = useRecoveryStore((state) => state.checkHardware)
  const restartDashboard = useRecoveryStore((state) => state.restartDashboard)
  const devices = useSetup((state) => state.devices)
  const loadDevices = useSetup((state) => state.loadDevices)
  const hardwareStatus = useHardwareStore((state) => state.hardwareStatus)
  const fetchHardwareStatus = useHardwareStore((state) => state.fetchHardwareStatus)

  useEffect(() => {
    void loadDevices()
  }, [loadDevices])

  const hardwareRows = useMemo(
    () => [
      ...devices.arms.map((arm) => ({
        key: `arm:${arm.alias}`,
        kind: 'arm' as const,
        alias: arm.alias,
        badge: arm.type,
      })),
      ...devices.cameras.map((camera) => ({
        key: `camera:${camera.alias}`,
        kind: 'camera' as const,
        alias: camera.alias,
        badge: camera.port,
      })),
    ],
    [devices.arms, devices.cameras],
  )
  const faultMap = useMemo(
    () => new Map(faults.map((fault) => [recoveryFaultKey(fault.fault_type, fault.device_alias), fault])),
    [faults],
  )
  const visibleFaults = useMemo(
    () => hasCheckedHardware
      ? hardwareRows.map((device) => primaryFaultFor(device)).filter((fault): fault is PrimaryFault => fault !== null)
      : [],
    [faultMap, hardwareRows, hasCheckedHardware],
  )
  const connectedCameras = hardwareStatus?.cameras.filter((camera) => camera.connected) || []

  async function handleRestart(): Promise<void> {
    try {
      await restartDashboard()
    } catch (error) {
      toast(error instanceof Error ? error.message : t('recoveryRestartFailed'), 'e')
    }
  }

  async function handleHardwareCheck(): Promise<void> {
    try {
      await loadDevices()
      await checkHardware()
      await fetchHardwareStatus()
    } catch (error) {
      toast(error instanceof Error ? error.message : t('recoveryCheckHardwareFailed'), 'e')
    }
  }

  function faultFor(faultType: RecoveryFaultType, alias: string) {
    return faultMap.get(recoveryFaultKey(faultType, alias))
  }

  function buildPrimaryFault(device: HardwareRow, fault: RecoveryFault, title: string, fallback: string): PrimaryFault {
    return {
      key: recoveryFaultKey(fault.fault_type, fault.device_alias),
      alias: device.alias,
      badge: device.badge,
      title,
      message: fault.message || fallback,
    }
  }

  function primaryFaultFor(device: HardwareRow): PrimaryFault | null {
    if (device.kind === 'camera') {
      const serialFault = faultFor(RECOVERY_FAULT_TYPES.CAMERA_DISCONNECTED, device.alias)
      if (serialFault) return buildPrimaryFault(device, serialFault, t('recoveryFaultCameraTitle'), t('recoveryFaultCameraFallback'))

      const frameFault = faultFor(RECOVERY_FAULT_TYPES.CAMERA_FRAME_DROP, device.alias)
      if (frameFault) return buildPrimaryFault(device, frameFault, t('recoveryFaultCameraFrameTitle'), t('recoveryFaultCameraFrameFallback'))
      return null
    }

    const serialFault = faultFor(RECOVERY_FAULT_TYPES.ARM_DISCONNECTED, device.alias)
    if (serialFault) return buildPrimaryFault(device, serialFault, t('recoveryFaultSerialTitle'), t('recoveryFaultSerialFallback'))

    const calibrationFault = faultFor(RECOVERY_FAULT_TYPES.ARM_NOT_CALIBRATED, device.alias)
    if (calibrationFault) return buildPrimaryFault(device, calibrationFault, t('recoveryFaultCalibrationTitle'), t('recoveryFaultCalibrationFallback'))

    const motorFault = faultFor(RECOVERY_FAULT_TYPES.ARM_MOTOR_DISCONNECTED, device.alias)
    if (motorFault) {
      const fallback = t('recoveryMotorFaultDetail', { motors: motorFault.message || device.alias })
      return buildPrimaryFault(device, motorFault, t('recoveryFaultMotorTitle'), fallback)
    }

    return null
  }

  return (
    <div className="page-enter flex h-full flex-col overflow-y-auto">
      <div className="w-full px-6 pt-5 2xl:px-10">
        <section className="flex min-h-[88px] items-center justify-center rounded-lg border border-bd/45 bg-white/82 px-5 py-4 shadow-card backdrop-blur">
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => { void handleRestart() }}
              disabled={restarting}
              className="min-h-[48px] rounded-full bg-ac px-7 text-sm font-bold text-white shadow-glow-ac transition-all hover:bg-ac2 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {restarting ? t('recoveryRestarting') : t('recoveryRestartDashboard')}
            </button>
          </div>
        </section>
      </div>

      <div className="flex-1 w-full px-6 py-5 2xl:px-10">
        {!hasCheckedHardware ? (
          <section className="rounded-[28px] border border-bd/45 bg-white/80 p-5 shadow-card backdrop-blur">
            <div className="grid min-h-[260px] place-items-center">
              {hardwareRows.length === 0 ? (
                <div className="rounded-2xl border border-bd/45 bg-white px-6 py-4 text-sm font-semibold text-tx3">
                  {t('noConfiguredDevices')}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => { void handleHardwareCheck() }}
                  disabled={checkingHardware}
                  className="min-h-[56px] rounded-full bg-ac px-8 text-sm font-bold text-white shadow-glow-ac transition-all hover:bg-ac2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkingHardware ? t('recoveryCheckingHardware') : t('recoveryCheckHardware')}
                </button>
              )}
            </div>
          </section>
        ) : (
          <section className="space-y-5">
            <div className="space-y-5">
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => { void handleHardwareCheck() }}
                  disabled={checkingHardware}
                  className="rounded-full bg-ac px-5 py-2 text-sm font-semibold text-white shadow-glow-ac transition-all hover:bg-ac2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {checkingHardware ? t('recoveryCheckingHardware') : t('recoveryCheckHardware')}
                </button>
              </div>

              <div className="grid gap-5 lg:grid-cols-[minmax(280px,0.82fr)_minmax(360px,1.18fr)]">
                <section className="min-w-0">
                  <div className="text-sm font-black tracking-[0.08em] text-tx3">
                    {visibleFaults.length ? t('recoveryFaultsFoundTitle') : t('recoveryNoFaultsTitle')}
                  </div>
                  {visibleFaults.length ? (
                    <div className="mt-4 space-y-3">
                      {visibleFaults.map((fault) => (
                        <article key={fault.key} className="border-l-2 border-rd bg-white/72 py-3 pl-4 pr-2">
                          <div className="flex min-w-0 items-center gap-2">
                            <strong className="truncate text-sm text-tx">{fault.alias}</strong>
                            <span className="font-mono text-xs text-tx3">
                              {fault.badge}
                            </span>
                          </div>
                          <div className="mt-3 text-sm font-black text-rd">{fault.title}</div>
                          <p className="mt-1 text-sm leading-6 text-tx2">{fault.message}</p>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-4 text-sm leading-6 text-tx2">{t('recoveryNoFaultsDesc')}</p>
                  )}
                </section>

                <section className="min-w-0 rounded-[24px] bg-white/78 p-5 shadow-card">
                  <div className="mb-4 text-sm font-black tracking-[0.08em] text-tx3">
                    {t('recoveryCameraPreviewTitle')}
                  </div>
                  {connectedCameras.length ? (
                    <CameraPreviewPanel cameras={connectedCameras} busy={false} />
                  ) : (
                    <div className="grid min-h-[240px] place-items-center rounded-2xl bg-bg px-5 text-sm font-semibold text-tx3">
                      {t('recoveryNoCameraPreview')}
                    </div>
                  )}
                </section>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}
