import { useEffect, useMemo } from 'react'
import { useToast } from '@/app/shell/ToastOutlet'
import { CameraPreviewPanel } from '@/domains/control/components/CameraPreviewPanel'
import { ServoPanel } from '@/domains/hardware/components/ServoPanel'
import { useHardwareStore } from '@/domains/hardware/store/useHardwareStore'
import {
  RECOVERY_FAULT_TYPES,
  recoveryFaultKey,
  type RecoveryFaultType,
  useRecoveryStore,
} from '@/domains/recovery/store/useRecoveryStore'
import { useSessionStore } from '@/domains/session/store/useSessionStore'
import { useSetup } from '@/domains/hardware/setup/store/useSetupStore'
import { useI18n } from '@/i18n'

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
  const session = useSessionStore((state) => state.session)
  const fetchSessionStatus = useSessionStore((state) => state.fetchSessionStatus)

  useEffect(() => {
    void loadDevices()
    void fetchHardwareStatus()
    void fetchSessionStatus()
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void fetchHardwareStatus()
        void fetchSessionStatus()
      }
    }, 5000)
    return () => clearInterval(timer)
  }, [fetchHardwareStatus, fetchSessionStatus, loadDevices])

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

  async function handleRestart(): Promise<void> {
    try {
      await restartDashboard()
    } catch (error) {
      toast(error instanceof Error ? error.message : t('recoveryRestartFailed'), 'e')
    }
  }

  async function handleHardwareCheck(): Promise<void> {
    try {
      await checkHardware()
    } catch (error) {
      toast(error instanceof Error ? error.message : t('recoveryCheckHardwareFailed'), 'e')
    }
  }

  function faultFor(faultType: RecoveryFaultType, alias: string) {
    return faultMap.get(recoveryFaultKey(faultType, alias))
  }

  function statusText(ok: boolean): string {
    return ok ? t('recoveryStatusNormal') : t('recoveryStatusAbnormal')
  }

  function statusTone(ok: boolean): string {
    return ok ? 'text-gn' : 'text-rd'
  }

  const busy = session.state !== 'idle' && session.state !== 'error'
  const camerasExist = hardwareStatus && hardwareStatus.cameras.some((camera) => camera.connected)

  function motorStatus(alias: string): { text: string; tone: string } {
    if (!hasCheckedHardware) {
      return { text: '--', tone: 'text-tx3' }
    }
    const fault = faultFor(RECOVERY_FAULT_TYPES.ARM_MOTOR_DISCONNECTED, alias)
    if (!fault) {
      return { text: t('recoveryStatusNormal'), tone: 'text-gn' }
    }
    return {
      text: t('recoveryMotorFaultDetail' as never, { motors: fault.message } as never),
      tone: 'text-rd',
    }
  }

  function renderMetric(label: string, value: string, tone = 'text-tx2') {
    return (
      <div key={label} className="min-w-0">
        <div className="text-[11px] font-semibold text-tx3">{label}</div>
        <div className={`mt-1 truncate text-sm font-semibold ${tone}`}>{value}</div>
      </div>
    )
  }

  function deviceMetrics(device: typeof hardwareRows[number]) {
    if (!hasCheckedHardware) {
      const pendingMetrics = [
        { label: t('recoverySerialConnection'), value: '--', tone: 'text-tx3' },
      ]
      if (device.kind === 'arm') {
        return [
          ...pendingMetrics,
          { label: t('recoveryCalibrationStatus'), value: '--', tone: 'text-tx3' },
          { label: t('recoveryMotorWiring'), value: '--', tone: 'text-tx3' },
        ]
      }
      return [
        ...pendingMetrics,
        { label: t('camera'), value: '--', tone: 'text-tx3' },
      ]
    }

    const serialOk = !faultFor(
      device.kind === 'arm'
        ? RECOVERY_FAULT_TYPES.ARM_DISCONNECTED
        : RECOVERY_FAULT_TYPES.CAMERA_DISCONNECTED,
      device.alias,
    )
    const serialMetric = {
      label: t('recoverySerialConnection'),
      value: statusText(serialOk),
      tone: statusTone(serialOk),
    }
    if (device.kind === 'camera') {
      return [
        serialMetric,
        { label: t('camera'), value: serialMetric.value, tone: serialMetric.tone },
      ]
    }

    const calibrationFault = faultFor(RECOVERY_FAULT_TYPES.ARM_NOT_CALIBRATED, device.alias)
    const motor = motorStatus(device.alias)
    return [
      serialMetric,
      {
        label: t('recoveryCalibrationStatus'),
        value: calibrationFault ? t('hwUncalibrated') : t('hwCalibrated'),
        tone: calibrationFault ? 'text-rd' : 'text-gn',
      },
      { label: t('recoveryMotorWiring'), value: motor.text, tone: motor.tone },
    ]
  }

  function renderDeviceRow(device: typeof hardwareRows[number]) {
    const baseClass = 'grid items-center gap-3 rounded-lg border border-bd/45 bg-white/85 px-4 py-3 shadow-card md:grid-cols-[minmax(150px,0.65fr)_minmax(0,2.35fr)]'
    const metrics = deviceMetrics(device)

    return (
      <div key={device.key} className={baseClass}>
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-bold text-tx">{device.alias}</span>
          <span className="rounded border border-bd/40 bg-white px-1.5 py-0.5 text-2xs font-mono text-tx2">
            {device.badge}
          </span>
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          {metrics.map((metric) => renderMetric(metric.label, metric.value, metric.tone))}
        </div>
      </div>
    )
  }

  return (
    <div className="page-enter flex h-full flex-col overflow-y-auto">
      <div className="w-full px-6 pt-5 2xl:px-10">
        <section className="flex min-h-[88px] items-center justify-between gap-4 rounded-lg border border-bd/45 bg-white/82 px-5 py-4 shadow-card backdrop-blur">
          <div className="min-w-0">
            <div className="text-[11px] font-black uppercase tracking-[0.18em] text-tx3">Dashboard</div>
            <div className="mt-1 text-lg font-black text-tx">恢复操作</div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden rounded-full border border-gn/20 bg-gn/10 px-3 py-1 text-xs font-bold text-gn sm:inline-flex">
              可用
            </span>
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
        <div className="space-y-5">
          <section className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-tx">
                  {t('recoveryActiveFaults')}
                </h3>
                <p className="mt-1 text-sm text-tx3">
                  {t('recoveryFaultCount', { count: String(faults.length) })}
                </p>
              </div>
              <button
                type="button"
                onClick={() => { void handleHardwareCheck() }}
                disabled={checkingHardware}
                className="rounded-full bg-ac px-4 py-2 text-sm font-semibold text-white shadow-glow-ac transition-all hover:bg-ac2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {checkingHardware ? t('recoveryCheckingHardware') : t('recoveryCheckHardware')}
              </button>
            </div>

            {hardwareRows.length === 0 ? (
              <div className="rounded-lg border border-bd/45 bg-white/85 p-4 text-sm text-tx3 shadow-card">
                {t('noConfiguredDevices')}
              </div>
            ) : (
              <div className="space-y-2.5">
                {hardwareRows.map((device) => renderDeviceRow(device))}
                {hasCheckedHardware && faults.length === 0 && (
                  <div className="rounded-lg border border-gn/20 bg-gn/5 px-4 py-3 text-sm font-semibold text-gn">
                    {t('recoveryNoFaultsDesc')}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-[0.16em] text-tx">
                设备诊断
              </h3>
            </div>

            <div className="grid min-h-[240px] grid-cols-2 gap-4 max-[1000px]:grid-cols-1">
              {camerasExist ? (
                <CameraPreviewPanel cameras={hardwareStatus!.cameras} busy={busy} />
              ) : (
                <div className="flex items-center justify-center rounded-lg bg-white/85 p-4 text-sm text-tx3 shadow-card">
                  没有可用相机画面
                </div>
              )}
              <ServoPanel state={session.state} />
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
