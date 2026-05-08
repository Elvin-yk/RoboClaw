import { useEffect, useMemo } from 'react'
import { useToast } from '@/app/shell/ToastOutlet'
import { CameraPreviewPanel } from '@/domains/control/components/CameraPreviewPanel'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import { useSetup } from '@/domains/hardware/setup/store/useSetupStore'
import {
  RECOVERY_FAULT_TYPES,
  recoveryFaultKey,
  type RecoveryFault,
  type RecoveryFaultType,
  useDeviceRecoveryStore,
} from '@/domains/control/store/useDeviceRecoveryStore'
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

export function DeviceConnectionCheckPanel() {
  const { t } = useI18n()
  const toast = useToast((state) => state.add)
  const faults = useDeviceRecoveryStore((state) => state.faults)
  const hasCheckedHardware = useDeviceRecoveryStore((state) => state.hasCheckedHardware)
  const checkingHardware = useDeviceRecoveryStore((state) => state.checkingHardware)
  const checkHardware = useDeviceRecoveryStore((state) => state.checkHardware)
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
    <section className="control-device-check">
      {!hasCheckedHardware ? (
        <div className="control-device-check__idle">
          {hardwareRows.length === 0 ? (
            <div className="control-device-check__empty">{t('noConfiguredDevices')}</div>
          ) : (
            <button
              type="button"
              onClick={() => { void handleHardwareCheck() }}
              disabled={checkingHardware}
              className="control-device-check__primary"
            >
              {checkingHardware ? t('recoveryCheckingHardware') : t('recoveryCheckHardware')}
            </button>
          )}
        </div>
      ) : (
        <div className="control-device-check__checked">
          <div className="control-device-check__toolbar">
            <div className="control-device-check__summary">
              {visibleFaults.length ? t('recoveryFaultsFoundTitle') : t('recoveryNoFaultsTitle')}
            </div>
            <button
              type="button"
              onClick={() => { void handleHardwareCheck() }}
              disabled={checkingHardware}
              className="control-device-check__secondary"
            >
              {checkingHardware ? t('recoveryCheckingHardware') : t('recoveryCheckHardware')}
            </button>
          </div>

          <div className="control-device-check__content">
            <div className="control-device-faults">
              {visibleFaults.length ? (
                visibleFaults.map((fault) => (
                  <article key={fault.key} className="control-device-fault">
                    <div className="control-device-fault__meta">
                      <strong>{fault.alias}</strong>
                      <span>{fault.badge}</span>
                    </div>
                    <div className="control-device-fault__title">{fault.title}</div>
                    <p>{fault.message}</p>
                  </article>
                ))
              ) : (
                <p className="control-device-check__healthy">{t('recoveryNoFaultsDesc')}</p>
              )}
            </div>

            {connectedCameras.length > 0 && (
              <div className="control-device-check__camera">
                <CameraPreviewPanel cameras={connectedCameras} busy={checkingHardware} />
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  )
}
