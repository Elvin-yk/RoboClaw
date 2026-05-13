import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useDataLibraryStore } from '@/domains/data/store/libraryStore'
import { useSessionStore } from '@/domains/session/store/useSessionStore'
import { useTrainingStore, type TrainingCurve } from '@/domains/training/store/useTrainingStore'
import { useHubTransferStore } from '@/domains/hub/store/useHubTransferStore'
import { LossCurvePanel } from '@/domains/training/components/LossCurvePanel'
import { TrainingProgressPanel } from '@/domains/training/components/TrainingProgressPanel'
import { useI18n } from '@/i18n'
import { useAuthStore } from '@/shared/lib/authStore'
import { postJson } from '@/shared/api/client'
import { RemoteTerminalPanel } from '@/domains/training/pages/WebTerminalPage'

const POLICY_TYPES = [
  'act',
  'diffusion',
  'groot',
  'multi_task_dit',
  'pi0',
  'pi0_fast',
  'pi05',
  'reward_classifier',
  'sac',
  'sarm',
  'smolvla',
  'tdmpc',
  'vqbet',
  'wall_x',
  'xvla',
]

type TrainingMode = 'local' | 'remote'
type RemoteTrainingTab = 'dispatch' | 'monitor' | 'tasks' | 'results'
const REMOTE_TRAINING_START = '/api/train/remote/start'
const REMOTE_TRAINING_DOWNLOAD = '/api/train/remote/download'
const REMOTE_TRAINING_DOWNLOAD_PROGRESS = '/api/train/remote/download/progress'
const REMOTE_TRAINING_LOSS = '/api/train/remote/loss'
const REMOTE_WAITING_MESSAGE = '等待服务器响应'
const REMOTE_DEFAULT_DATASET = '默认数据集'

type RemoteTrainingTask = {
  taskName: string
  status: string
}

type RemoteDownloadProgress = {
  downloadedBytes: number
  totalBytes: number
  status: string
}

type RemoteCheckpointDirectory = {
  id: string
  name: string
  downloadSize: number
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let size = value
  let unitIndex = 0
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size >= 10 || unitIndex === 0 ? size.toFixed(0) : size.toFixed(1)} ${units[unitIndex]}`
}

function makeDownloadId() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

declare global {
  var webterminal_url: string
}

export default function TrainingCenterPage() {
  const location = useLocation()
  const datasets = useDataLibraryStore((state) => state.datasets)
  const loadDataLibrary = useDataLibraryStore((state) => state.load)
  const session = useSessionStore((state) => state.session)
  const policies = useTrainingStore((state) => state.policies)
  const loadPolicies = useTrainingStore((state) => state.loadPolicies)
  const restoreCurrentTrainJob = useTrainingStore((state) => state.restoreCurrentTrainJob)
  const doTrainStart = useTrainingStore((state) => state.doTrainStart)
  const doTrainStop = useTrainingStore((state) => state.doTrainStop)
  const currentTrainJobId = useTrainingStore((state) => state.currentTrainJobId)
  const trainingLoading = useTrainingStore((state) => state.trainingLoading)
  const trainingStopLoading = useTrainingStore((state) => state.trainingStopLoading)
  const hubLoading = useHubTransferStore((state) => state.hubLoading)
  const hubProgress = useHubTransferStore((state) => state.hubProgress)
  const pushPolicy = useHubTransferStore((state) => state.pushPolicy)
  const pullPolicy = useHubTransferStore((state) => state.pullPolicy)
  const isLoggedIn = useAuthStore((state) => state.isLoggedIn)
  const user = useAuthStore((state) => state.user)
  const { t } = useI18n()
  const runtimeDatasets = datasets.filter((dataset) => dataset.id.startsWith('local/'))

  const [trainDataset, setTrainDataset] = useState('')
  const [policyType, setPolicyType] = useState('act')
  const [trainSteps, setTrainSteps] = useState(100000)
  const [trainDevice, setTrainDevice] = useState('cuda')
  const [pullPolicyRepo, setPullPolicyRepo] = useState('')
  const trainingMode: TrainingMode = location.pathname.startsWith('/training/remote') ? 'remote' : 'local'
  const [remoteDatasetPath, setRemoteDatasetPath] = useState(REMOTE_DEFAULT_DATASET)
  const [remoteDatasetDirs, setRemoteDatasetDirs] = useState<string[]>([])
  const [remoteEpochs, setRemoteEpochs] = useState(1)
  const [remoteCheckpointEpochs, setRemoteCheckpointEpochs] = useState(1)
  const [remoteTaskName, setRemoteTaskName] = useState('')
  const [remoteGpuCount, setRemoteGpuCount] = useState(1)
  const [remoteGpuType, setRemoteGpuType] = useState('')
  const [remoteBatchSize, setRemoteBatchSize] = useState(16)
  const [remotePolicyType, setRemotePolicyType] = useState('act')
  const [remoteEmptyDocker, setRemoteEmptyDocker] = useState(false)
  const [remoteSleepT, setRemoteSleepT] = useState(6000)
  const [remoteLogFreq, setRemoteLogFreq] = useState(100)
  const [remoteTasks, setRemoteTasks] = useState<Record<string, RemoteTrainingTask>>({})
  const [remoteServerConnected, setRemoteServerConnected] = useState(false)
  const [remoteTrainingPending, setRemoteTrainingPending] = useState(false)
  const [remoteDownloadPending, setRemoteDownloadPending] = useState(false)
  const [remoteDownloadProgress, setRemoteDownloadProgress] = useState<RemoteDownloadProgress | null>(null)
  const [remoteCheckpointDirectories, setRemoteCheckpointDirectories] = useState<RemoteCheckpointDirectory[]>([])
  const [selectedRemoteCheckpoints, setSelectedRemoteCheckpoints] = useState<string[]>([])
  const [remoteDownloadTotalBytes, setRemoteDownloadTotalBytes] = useState(0)
  const [remoteCreateMessage, setRemoteCreateMessage] = useState('')
  const [webTerminalUrl, setWebTerminalUrl] = useState('')
  const [selectedRemoteTaskName, setSelectedRemoteTaskName] = useState('')
  const [remoteTrainLogs, setRemoteTrainLogs] = useState('')
  const [remoteLossCurve, setRemoteLossCurve] = useState<TrainingCurve | null>(null)
  const [remoteTrainingTab, setRemoteTrainingTab] = useState<RemoteTrainingTab>('dispatch')
  const [showRemoteTerminal, setShowRemoteTerminal] = useState(false)
  const remoteTaskNames = Object.keys(remoteTasks)
  const remoteTaskCount = Object.keys(remoteTasks).length
  const remoteBusy = remoteTrainingPending || remoteDownloadPending
  const remoteDatasetOptions = [
    REMOTE_DEFAULT_DATASET,
    ...remoteDatasetDirs.filter(datasetDir => datasetDir !== REMOTE_DEFAULT_DATASET),
  ]
  const remoteTabs: Array<{ id: RemoteTrainingTab; label: string }> = [
    { id: 'dispatch', label: '训练下发' },
    { id: 'monitor', label: '任务监视' },
    { id: 'tasks', label: '任务管理' },
    { id: 'results', label: '结果下载' },
  ]

  useEffect(() => {
    void loadDataLibrary()
    void loadPolicies()
    void restoreCurrentTrainJob()
  }, [loadDataLibrary, loadPolicies, restoreCurrentTrainJob])

  const promptPushPolicy = (value: string) => {
    const repoId = prompt(t('enterRepoId'))
    if (!repoId) return
    void pushPolicy(value, repoId)
  }

  const clampNumber = (value: string, min: number, max: number) => {
    return Math.min(max, Math.max(min, Number(value) || min))
  }

  const startRemoteTraining = async () => {
    const taskName = remoteTaskName.trim()
    const datasetPath = remoteDatasetPath.trim()
    const username = user?.nickname || user?.phone || user?.id || ''
    const validEpochs = remoteEpochs >= 1 && remoteEpochs <= 10000000
    const validCheckpointEpochs = remoteCheckpointEpochs >= 1 && remoteCheckpointEpochs <= 10000000
    if (
      !datasetPath ||
      !validEpochs ||
      !validCheckpointEpochs ||
      remoteCheckpointEpochs > remoteEpochs ||
      remoteGpuCount < 1 ||
      remoteSleepT < 300 ||
      remoteSleepT > 6000 ||
      remoteLogFreq < 1 ||
      ![16, 32, 64, 128].includes(remoteBatchSize) ||
      !POLICY_TYPES.includes(remotePolicyType) ||
      !/^[A-Za-z0-9]{1,150}$/.test(taskName)
    ) {
      alert('请检查训练参数')
      return
    }
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage(REMOTE_WAITING_MESSAGE)
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName,
        datasetName: datasetPath,
        steps: remoteEpochs,
        saveFreq: remoteCheckpointEpochs,
        gpuCount: remoteGpuCount,
        gpuType: remoteGpuType.trim(),
        batchSize: remoteBatchSize,
        policyType: remotePolicyType,
        emptyDocker: remoteEmptyDocker,
        sleepT: remoteSleepT,
        logFreq: remoteLogFreq,
        action: '开始训练',
      }) as { message?: string; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      setRemoteCreateMessage(response.message === 'create task success' ? '创建成功' : '创建失败')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const endRemoteTraining = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage(REMOTE_WAITING_MESSAGE)
    setWebTerminalUrl('')
    setShowRemoteTerminal(false)
    sessionStorage.removeItem('webterminal_url')
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName: selectedRemoteTaskName,
        action: '结束训练',
      }) as { message?: string; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      if (!nextTasks[selectedRemoteTaskName]) setSelectedRemoteTaskName('')
      setRemoteCreateMessage(response.message || '')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const deleteRemoteTraining = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage(REMOTE_WAITING_MESSAGE)
    setWebTerminalUrl('')
    setShowRemoteTerminal(false)
    sessionStorage.removeItem('webterminal_url')
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName: selectedRemoteTaskName,
        action: '删除任务',
      }) as { message?: string; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      if (!nextTasks[selectedRemoteTaskName]) setSelectedRemoteTaskName('')
      setRemoteCreateMessage(response.message || '')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const queryRemoteTaskStatus = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage(REMOTE_WAITING_MESSAGE)
    setWebTerminalUrl('')
    setShowRemoteTerminal(false)
    sessionStorage.removeItem('webterminal_url')
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName: selectedRemoteTaskName,
        action: '查询状态',
      }) as { message?: string; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      const message = response.message || '查询完成'
      const linkMatch = message.match(/Link:\s*(\S+)/)
      if (linkMatch) {
        globalThis.webterminal_url = linkMatch[1]
        sessionStorage.setItem('webterminal_url', linkMatch[1])
        setWebTerminalUrl(linkMatch[1])
      }
      setRemoteCreateMessage(message)
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const syncRemoteTasks = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage(REMOTE_WAITING_MESSAGE)
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        action: '任务同步',
      }) as { message?: string; tasks?: RemoteTrainingTask[]; datasetDir?: string[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      const nextDatasetDirs = Array.isArray(response.datasetDir)
        ? response.datasetDir.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        : []
      setRemoteTasks(nextTasks)
      setRemoteDatasetDirs(nextDatasetDirs)
      if (remoteDatasetPath !== REMOTE_DEFAULT_DATASET && !nextDatasetDirs.includes(remoteDatasetPath)) {
        setRemoteDatasetPath(REMOTE_DEFAULT_DATASET)
      }
      if (selectedRemoteTaskName && !nextTasks[selectedRemoteTaskName]) setSelectedRemoteTaskName('')
      setRemoteServerConnected(response.message === 'sync success')
      setRemoteCreateMessage(response.message === 'sync success' ? '同步成功' : '同步失败')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const queryRemoteDownloadDirectory = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteDownloadProgress(null)
    setRemoteCheckpointDirectories([])
    setSelectedRemoteCheckpoints([])
    setRemoteDownloadTotalBytes(0)
    setRemoteCreateMessage('正在查询下载目录...')
    try {
      const sizePayload = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName: selectedRemoteTaskName,
        action: '查询下载目录',
      }) as {
        message?: string
        downloadSize?: number
        checkpoints?: RemoteCheckpointDirectory[]
      }
      const checkpoints = sizePayload.checkpoints || []
      const totalBytes = Number(sizePayload.downloadSize || 0)
      setRemoteCheckpointDirectories(checkpoints)
      setRemoteDownloadTotalBytes(totalBytes)
      setRemoteCreateMessage(
        checkpoints.length
          ? `查询完成 · ${checkpoints.length} 个 checkpoint · 全部 ${formatBytes(totalBytes)}`
          : sizePayload.message || '未找到 checkpoint'
      )
    } catch (error) {
      setRemoteCreateMessage(error instanceof Error ? error.message : '查询失败')
    }
  }

  const refreshRemoteTrainLogs = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteTrainingPending(true)
    setRemoteCreateMessage('正在刷新日志...')
    try {
      const response = await postJson(REMOTE_TRAINING_START, {
        username,
        taskName: selectedRemoteTaskName,
        action: '请求用户日志',
      }) as { message?: string; logs?: string[]; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      setRemoteTrainLogs((response.logs || []).join('\n'))
      setRemoteCreateMessage(response.message || '日志刷新完成')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  const refreshRemoteLossCurve = async () => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    setRemoteDownloadPending(true)
    setRemoteCreateMessage('正在下载损失文件...')
    try {
      const params = new URLSearchParams({
        username,
        taskName: selectedRemoteTaskName,
        limit: '1000',
      })
      const response = await fetch(`${REMOTE_TRAINING_LOSS}?${params.toString()}`)
      if (!response.ok) throw new Error(await response.text())
      const curve = await response.json() as TrainingCurve & { message?: string }
      setRemoteLossCurve(curve)
      setRemoteCreateMessage(curve.message || '损失曲线刷新完成')
    } catch (error) {
      setRemoteCreateMessage(error instanceof Error ? error.message : '损失曲线刷新失败')
    } finally {
      setRemoteDownloadPending(false)
    }
  }

  const toggleRemoteCheckpoint = (checkpointId: string) => {
    setSelectedRemoteCheckpoints((current) => {
      if (current.includes(checkpointId)) {
        return current.filter(id => id !== checkpointId)
      }
      if (current.length >= 5) {
        setRemoteCreateMessage('每次最多选择 5 个 checkpoint')
        return current
      }
      return [...current, checkpointId]
    })
  }

  const startRemoteDownload = async (downloadAll: boolean) => {
    const username = user?.nickname || user?.phone || user?.id || ''
    if (remoteDownloadPending) return
    if (!selectedRemoteTaskName) return
    if (!username) {
      alert('请先登陆')
      return
    }
    if (!downloadAll && selectedRemoteCheckpoints.length === 0) {
      setRemoteCreateMessage('请先选择至少一个 checkpoint')
      return
    }
    const selectedSet = new Set(selectedRemoteCheckpoints)
    const selectedBytes = remoteCheckpointDirectories
      .filter(checkpoint => selectedSet.has(checkpoint.id))
      .reduce((sum, checkpoint) => sum + Number(checkpoint.downloadSize || 0), 0)
    const totalBytes = downloadAll
      ? remoteDownloadTotalBytes
      : selectedBytes
    if (!totalBytes) {
      setRemoteCreateMessage('请先查询下载目录')
      return
    }

    setRemoteDownloadPending(true)
    setRemoteDownloadProgress({ downloadedBytes: 0, totalBytes, status: 'downloading' })
    setRemoteCreateMessage(`下载中 0% · 0 B / ${formatBytes(totalBytes)}`)
    try {
      const downloadId = makeDownloadId()
      const downloadList = selectedRemoteCheckpoints.join(',')
      const params = new URLSearchParams({
        username,
        taskName: selectedRemoteTaskName,
        downloadId,
        downloadAll: String(downloadAll),
        downloadList,
        expectedSize: String(totalBytes),
      })

      const link = document.createElement('a')
      link.href = `${REMOTE_TRAINING_DOWNLOAD}?${params.toString()}`
      link.download = `${selectedRemoteTaskName}-result.tar`
      document.body.appendChild(link)
      link.click()
      link.remove()

      const timer = window.setInterval(async () => {
        try {
          const progressParams = new URLSearchParams({ downloadId })
          const response = await fetch(`${REMOTE_TRAINING_DOWNLOAD_PROGRESS}?${progressParams.toString()}`)
          if (!response.ok) return
          const progress = await response.json() as RemoteDownloadProgress
          const downloadedBytes = Number(progress.downloadedBytes || 0)
          const knownTotalBytes = Number(progress.totalBytes || totalBytes)
          const percent = knownTotalBytes ? Math.min(100, Math.floor((downloadedBytes / knownTotalBytes) * 100)) : 0
          setRemoteDownloadProgress({ downloadedBytes, totalBytes: knownTotalBytes, status: progress.status })
          setRemoteCreateMessage(`下载中 ${percent}% · ${formatBytes(downloadedBytes)} / ${formatBytes(knownTotalBytes)}`)
          if (progress.status === 'completed' || progress.status === 'failed') {
            window.clearInterval(timer)
            setRemoteDownloadPending(false)
            setRemoteCreateMessage(
              progress.status === 'completed'
                ? `下载完成 · ${formatBytes(knownTotalBytes)}`
                : '下载失败'
            )
          }
        } catch {
          // Keep the browser download alive even if one progress poll fails.
        }
      }, 1000)
    } catch (error) {
      setRemoteCreateMessage(error instanceof Error ? error.message : '下载失败')
      setRemoteDownloadPending(false)
    }
  }

  return (
    <div className="page-enter flex flex-col h-full overflow-y-auto">
      <div className="border-b border-bd/50 px-6 py-4 bg-sf flex items-center justify-between gap-4 max-[760px]:flex-col max-[760px]:items-stretch">
        <h2 className="text-xl font-bold tracking-tight">{t('trainingCenter')}</h2>
        {trainingMode === 'remote' && (
          <div className="grid w-full max-w-[760px] grid-cols-4 gap-2 rounded-xl bg-bg p-1.5 max-[760px]:max-w-none">
            {remoteTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                disabled={remoteDownloadPending}
                onClick={() => setRemoteTrainingTab(tab.id)}
                className={`h-9 rounded-lg px-4 text-sm font-semibold transition-all active:scale-[0.98] ${
                  remoteTrainingTab === tab.id
                    ? 'bg-ac text-white shadow-glow-ac'
                    : 'text-tx2 hover:bg-ac/10 hover:text-ac'
                } disabled:cursor-not-allowed disabled:opacity-60`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {trainingMode === 'remote' ? (
        <div className="flex-1 p-6">
          {isLoggedIn ? (
            <div className="space-y-6">
              <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-gn">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-bold text-tx uppercase tracking-wide">服务器连接状态</h3>
                  <div className="flex items-center gap-3 text-sm text-tx2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${remoteServerConnected ? 'bg-gn' : 'bg-rd'}`}
                      />
                      <span>{remoteServerConnected ? '已同步' : '未连接'}</span>
                    </div>
                    <button
                      type="button"
                      disabled={remoteBusy}
                      onClick={syncRemoteTasks}
                      className="h-9 px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      任务同步
                    </button>
                  </div>
                </div>
              </section>

              {remoteTrainingTab === 'dispatch' && (
              <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">训练参数</h3>
                <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    数据集路径
                    <select
                      disabled={remoteDownloadPending}
                      value={remoteDatasetPath}
                      onChange={(e) => setRemoteDatasetPath(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    >
                      {remoteDatasetOptions.map(datasetPath => (
                        <option key={datasetPath} value={datasetPath}>{datasetPath}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    训练任务名称
                    <input
                      disabled={remoteDownloadPending}
                      value={remoteTaskName}
                      maxLength={150}
                      pattern="[A-Za-z0-9]{1,150}"
                      onChange={(e) => setRemoteTaskName(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    训练轮次
                    <input
                      disabled={remoteDownloadPending}
                      type="number"
                      min={1}
                      max={10000000}
                      value={remoteEpochs}
                      onChange={(e) => setRemoteEpochs(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    存档频率
                    <input
                      disabled={remoteDownloadPending}
                      type="number"
                      min={1}
                      max={10000000}
                      value={remoteCheckpointEpochs}
                      onChange={(e) => setRemoteCheckpointEpochs(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    GPU类型
                    <input
                      disabled={remoteDownloadPending}
                      value={remoteGpuType}
                      onChange={(e) => setRemoteGpuType(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    GPU数量
                    <input
                      disabled={remoteDownloadPending}
                      type="number"
                      min={1}
                      value={remoteGpuCount}
                      onChange={(e) => setRemoteGpuCount(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    Batch 大小
                    <select
                      disabled={remoteDownloadPending}
                      value={remoteBatchSize}
                      onChange={(e) => setRemoteBatchSize(Number(e.target.value))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    >
                      {[16, 32, 64, 128].map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    模型类型
                    <select
                      disabled={remoteDownloadPending}
                      value={remotePolicyType}
                      onChange={(e) => setRemotePolicyType(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    >
                      {POLICY_TYPES.map(type => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    创建空容器
                    <select
                      disabled={remoteDownloadPending}
                      value={remoteEmptyDocker ? 'true' : 'false'}
                      onChange={(e) => setRemoteEmptyDocker(e.target.value === 'true')}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    >
                      <option value="false">False</option>
                      <option value="true">True</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    空容器时间
                    <input
                      disabled={remoteDownloadPending}
                      type="number"
                      min={300}
                      max={6000}
                      value={remoteSleepT}
                      onChange={(e) => setRemoteSleepT(clampNumber(e.target.value, 300, 6000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    日志频率
                    <input
                      disabled={remoteDownloadPending}
                      type="number"
                      min={1}
                      value={remoteLogFreq}
                      onChange={(e) => setRemoteLogFreq(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <div className="flex items-end">
                    <button
                      disabled={remoteBusy}
                      onClick={startRemoteTraining}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-gn hover:bg-gn/90 shadow-glow-ac
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed disabled:shadow-none"
                    >
                      {remoteTrainingPending ? '创建中...' : '开始训练'}
                    </button>
                  </div>
                </div>
              </section>
              )}

              {remoteTrainingTab === 'monitor' && (
              <>
                <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                  <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">过程监测</h3>
                  <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
                    <label className="flex min-w-0 text-sm text-tx2">
                      <select
                        disabled={remoteDownloadPending}
                        value={selectedRemoteTaskName}
                        onChange={(e) => {
                          setSelectedRemoteTaskName(e.target.value)
                          setRemoteLossCurve(null)
                        }}
                        className="h-10 min-w-0 flex-1 bg-bg border border-bd text-tx px-3 rounded-lg text-sm focus:outline-none focus:border-ac"
                      >
                        <option value="">请选择任务</option>
                        {remoteTaskNames.map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="h-10 w-full px-3 rounded-lg border border-bd/40 bg-bg text-sm text-tx2 flex items-center justify-center">
                      当前任务数量：{remoteTaskCount}
                    </div>
                    <button
                      disabled={remoteBusy || !selectedRemoteTaskName}
                      onClick={refreshRemoteTrainLogs}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      刷新日志
                    </button>
                    <button
                      disabled={remoteBusy || !selectedRemoteTaskName}
                      onClick={refreshRemoteLossCurve}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-gn hover:bg-gn/90
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      损失可视化
                    </button>
                  </div>
                </section>
                <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                  <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">训练日志</h3>
                  <pre className="h-80 overflow-auto rounded-lg border border-bd bg-[#080b12] p-4 text-xs leading-5 text-white whitespace-pre-wrap">
                    {remoteTrainLogs || '暂无日志'}
                  </pre>
                </section>
                <LossCurvePanel
                  curve={remoteLossCurve}
                  title="损失可视化"
                  showJobInput={false}
                  gradientId="remote-loss-grad"
                />
              </>
              )}

              {remoteTrainingTab === 'tasks' && (
              <>
                <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                  <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">任务管理</h3>
                  <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-4 max-[900px]:grid-cols-1">
                    <label className="flex min-w-0 text-sm text-tx2">
                      <select
                        disabled={remoteDownloadPending}
                        value={selectedRemoteTaskName}
                        onChange={(e) => {
                          setSelectedRemoteTaskName(e.target.value)
                          setRemoteCheckpointDirectories([])
                          setSelectedRemoteCheckpoints([])
                          setRemoteDownloadTotalBytes(0)
                          setRemoteDownloadProgress(null)
                          setWebTerminalUrl('')
                          setShowRemoteTerminal(false)
                          sessionStorage.removeItem('webterminal_url')
                        }}
                        className="h-10 min-w-0 flex-1 bg-bg border border-bd text-tx px-3 rounded-lg text-sm focus:outline-none focus:border-ac"
                      >
                        <option value="">请选择任务</option>
                        {remoteTaskNames.map(name => (
                          <option key={name} value={name}>{name}</option>
                        ))}
                      </select>
                    </label>
                    <div className="h-10 w-full px-3 rounded-lg border border-bd/40 bg-bg text-sm text-tx2 flex items-center justify-center">
                      当前任务数量：{remoteTaskCount}
                    </div>
                    <button
                      disabled={remoteBusy || !selectedRemoteTaskName}
                      onClick={queryRemoteTaskStatus}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      查询状态
                    </button>
                  </div>
                  <div className="mt-4 grid grid-cols-3 gap-3 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
                    <button
                      type="button"
                      disabled={remoteDownloadPending || !webTerminalUrl}
                      onClick={() => setShowRemoteTerminal(true)}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-gn hover:bg-gn/90
                        transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      打开终端
                    </button>
                    <button
                      disabled={remoteBusy || !selectedRemoteTaskName}
                      onClick={() => {
                        if (confirm('该操作将会停止当前的训练任务')) void endRemoteTraining()
                      }}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-rd hover:bg-rd/90
                        transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                    >
                      终止任务
                    </button>
                    <button
                      disabled={remoteBusy || !selectedRemoteTaskName}
                      onClick={() => {
                        if (confirm('删除任务会导致训练任务的结果被删除，是否继续？')) void deleteRemoteTraining()
                      }}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-rd hover:bg-rd/90
                        transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                    >
                      删除任务
                    </button>
                  </div>
                </section>
                {showRemoteTerminal && webTerminalUrl && (
                  <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                    <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">远程终端</h3>
                    <div className="h-[460px] overflow-hidden rounded-lg border border-bd bg-[#080b12]">
                      <RemoteTerminalPanel className="h-full" />
                    </div>
                  </section>
                )}
              </>
              )}

              {remoteTrainingTab === 'results' && (
              <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">结果下载</h3>
                <div className="mb-4 grid grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4 max-[760px]:grid-cols-1">
                  <label className="flex min-w-0 text-sm text-tx2">
                    <select
                      disabled={remoteDownloadPending}
                      value={selectedRemoteTaskName}
                      onChange={(e) => {
                        setSelectedRemoteTaskName(e.target.value)
                        setRemoteCheckpointDirectories([])
                        setSelectedRemoteCheckpoints([])
                        setRemoteDownloadTotalBytes(0)
                        setRemoteDownloadProgress(null)
                      }}
                      className="h-10 min-w-0 flex-1 bg-bg border border-bd text-tx px-3 rounded-lg text-sm focus:outline-none focus:border-ac"
                    >
                      <option value="">请选择任务</option>
                      {remoteTaskNames.map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="h-10 w-full px-3 rounded-lg border border-bd/40 bg-bg text-sm text-tx2 flex items-center justify-center">
                    当前任务数量：{remoteTaskCount}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
                  <details className={`relative h-10 min-w-0 w-full rounded-lg border border-bd bg-bg px-3 text-sm text-tx2 open:z-20 ${remoteDownloadPending ? 'pointer-events-none opacity-60' : ''}`}>
                    <summary className="flex h-full cursor-pointer select-none items-center truncate text-tx">
                      Checkpoint · 已选 {selectedRemoteCheckpoints.length}/5
                      {remoteCheckpointDirectories.length > 0 ? ` · 共 ${remoteCheckpointDirectories.length} 个` : ''}
                    </summary>
                    {remoteCheckpointDirectories.length > 0 ? (
                      <div className="absolute left-0 top-full z-30 mt-2 grid max-h-56 w-full gap-2 overflow-y-auto rounded-lg border border-bd bg-bg p-2 shadow-card">
                        {remoteCheckpointDirectories.map((checkpoint, index) => (
                          <label key={checkpoint.id} className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-sf">
	                            <input
                              disabled={remoteDownloadPending}
	                              type="checkbox"
                              checked={selectedRemoteCheckpoints.includes(checkpoint.id)}
                              onChange={() => toggleRemoteCheckpoint(checkpoint.id)}
                              className="h-4 w-4"
                            />
                            <span className="min-w-0 flex-1 truncate text-tx">
                              {`Checkpoint${index} · ${checkpoint.name}`}
                            </span>
                            <span className="shrink-0 text-tx3">{formatBytes(Number(checkpoint.downloadSize || 0))}</span>
                          </label>
                        ))}
                      </div>
                    ) : (
                      <div className="absolute left-0 top-full z-30 mt-2 w-full rounded-lg border border-bd bg-bg p-2 shadow-card">
                        <div className="rounded-md bg-sf px-3 py-2 text-sm text-tx3">
                          请先查询下载目录
                        </div>
                      </div>
                    )}
                  </details>
                  <button
                    disabled={remoteBusy || !selectedRemoteTaskName}
                    onClick={queryRemoteDownloadDirectory}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2
                      transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    查询下载目录
                  </button>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-3 max-[520px]:grid-cols-1">
                  <button
                    disabled={remoteBusy || !selectedRemoteTaskName || selectedRemoteCheckpoints.length === 0}
                    onClick={() => void startRemoteDownload(false)}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-gn hover:bg-gn/90
                      transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    下载选中
                  </button>
                  <button
                    disabled={remoteBusy || !selectedRemoteTaskName || !remoteDownloadTotalBytes}
                    onClick={() => void startRemoteDownload(true)}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-gn hover:bg-gn/90
                      transition-all active:scale-[0.97] disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {remoteDownloadPending ? '下载中...' : '全部下载'}
                  </button>
                </div>
              </section>
              )}

              {remoteCreateMessage && (
                <section className="rounded-xl border border-bd/70 bg-sf px-4 py-3 shadow-card">
                  <div className="mb-2 text-sm font-semibold text-tx">服务器请求结果</div>
                  <div className="whitespace-pre-wrap break-words text-base leading-6 text-tx2">{remoteCreateMessage}</div>
                  {remoteDownloadProgress && remoteDownloadProgress.totalBytes > 0 && (
                    <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-bg">
                      <div
                        className="h-full bg-ac transition-[width] duration-300"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.floor((remoteDownloadProgress.downloadedBytes / remoteDownloadProgress.totalBytes) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  )}
                </section>
              )}
            </div>
          ) : (
            <div className="text-sm text-tx3">请先登陆</div>
          )}
        </div>
      ) : (
        <div className="flex-1 p-6 grid grid-cols-2 gap-6 items-start max-[1100px]:grid-cols-1">
        <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
          <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">{t('training')}</h3>
          <select
            value={trainDataset}
            onChange={(e) => setTrainDataset(e.target.value)}
            className="w-full bg-bg border border-bd text-tx px-3 py-2 rounded-lg text-sm mb-3
              focus:outline-none focus:border-ac"
          >
            <option value="">{t('selectDataset')}</option>
            {runtimeDatasets.map(d => (
              <option key={d.id} value={d.id.slice('local/'.length)}>{d.label}</option>
            ))}
          </select>
          <div className="mb-3 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(86px,96px)] gap-3 max-[700px]:grid-cols-1">
            <label className="flex min-w-0 flex-col gap-1 text-2xs text-tx3 font-mono">
              {t('policyType')}
              <select
                value={policyType}
                onChange={(e) => setPolicyType(e.target.value)}
                className="min-w-0 w-full bg-bg border border-bd text-tx px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-ac"
              >
                {POLICY_TYPES.map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-2xs text-tx3 font-mono">
              {t('steps')}
              <input type="number" value={trainSteps} onChange={(e) => setTrainSteps(Number(e.target.value) || 100000)}
                className="min-w-0 w-full bg-bg border border-bd text-tx px-3 py-2 rounded-lg text-sm font-mono focus:outline-none focus:border-ac" />
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-2xs text-tx3 font-mono">
              {t('device')}
              <select value={trainDevice} onChange={(e) => setTrainDevice(e.target.value)}
                className="min-w-0 w-full bg-bg border border-bd text-tx px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-ac">
                <option value="cuda">cuda</option>
                <option value="cpu">cpu</option>
              </select>
            </label>
          </div>
          <div className="flex gap-3 max-[520px]:flex-col">
            <button
              disabled={(session.state !== 'idle' && session.state !== 'error') || !trainDataset || !!trainingLoading}
              onClick={() => {
                void doTrainStart({
                  dataset_name: trainDataset,
                  policy_type: policyType,
                  steps: trainSteps,
                  device: trainDevice,
                })
              }}
              className="flex-1 px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2 shadow-glow-ac
                transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed disabled:shadow-none"
            >
              {trainingLoading ? t('startingTraining') : t('startTraining')}
            </button>
            <button
              disabled={!currentTrainJobId || !!trainingStopLoading}
              onClick={() => { void doTrainStop() }}
              className="px-4 py-2.5 rounded-lg text-sm font-semibold text-white bg-rd hover:bg-rd/90
                transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
            >
              {trainingStopLoading ? t('stoppingTraining') : t('stopTraining')}
            </button>
          </div>
        </section>

        <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-gn">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-bold text-tx uppercase tracking-wide">{t('policies') || 'Policies'}</h3>
            <button
              onClick={() => { void loadPolicies() }}
              className="px-2.5 py-0.5 bg-ac/10 text-ac rounded text-xs font-medium hover:bg-ac/20 transition-colors"
            >
              {t('refresh')}
            </button>
          </div>

          {policies.length === 0 && (
            <div className="text-tx3 text-center py-4 text-sm">{t('noPolicies')}</div>
          )}
          <div className="space-y-1.5">
            {policies.map((p: any, i: number) => (
              <div key={i} className="bg-bg border border-bd/30 rounded-lg px-3 py-2 text-sm flex items-center gap-2">
                <span className="flex-1 font-mono text-tx2 truncate">
                  {typeof p === 'string' ? p : p.name || JSON.stringify(p)}
                </span>
                <button
                  disabled={!!hubLoading}
                  onClick={() => promptPushPolicy(typeof p === 'string' ? p : p.name)}
                  className="px-2 py-0.5 text-ac/60 rounded text-xs hover:text-ac hover:bg-ac/10 transition-colors disabled:opacity-25"
                >
                  {t('pushToHub')}
                </button>
              </div>
            ))}
          </div>

          <div className="mt-4 pt-4 border-t border-bd/40">
            <h4 className="text-xs font-bold text-tx3 uppercase mb-2">{t('downloadPolicy')}</h4>
            <div className="flex gap-2">
              <input
                placeholder={t('repoIdPlaceholder')}
                value={pullPolicyRepo}
                onChange={(e) => setPullPolicyRepo(e.target.value)}
                className="flex-1 bg-bg border border-bd text-tx px-3 py-1.5 rounded-lg text-sm
                  focus:outline-none focus:border-ac"
              />
              <button
                disabled={!pullPolicyRepo || !!hubLoading}
                onClick={() => {
                  void pullPolicy(pullPolicyRepo)
                  setPullPolicyRepo('')
                }}
                className="px-3 py-1.5 bg-ac/10 text-ac rounded-lg text-sm font-medium
                  hover:bg-ac/20 transition-colors disabled:opacity-25 disabled:cursor-not-allowed"
              >
                {hubLoading === 'pullPolicy' ? t('downloading') : t('download')}
              </button>
            </div>
          </div>

          {hubProgress && !hubProgress.done && hubLoading === 'pullPolicy' && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-2xs text-tx3 mb-1">
                <span>{hubProgress.operation}</span>
                <span>{hubProgress.progress_percent.toFixed(1)}%</span>
              </div>
              <div className="w-full bg-bd/30 rounded-full h-1.5">
                <div
                  className="bg-gn h-1.5 rounded-full transition-all duration-300"
                  style={{ width: `${Math.min(hubProgress.progress_percent, 100)}%` }}
                />
              </div>
            </div>
          )}
        </section>

        <LossCurvePanel />
        <TrainingProgressPanel />
        </div>
      )}
    </div>
  )
}
