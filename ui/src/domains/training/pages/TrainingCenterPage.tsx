import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useDatasetsStore } from '@/domains/datasets/store/useDatasetsStore'
import { useSessionStore } from '@/domains/session/store/useSessionStore'
import { useTrainingStore } from '@/domains/training/store/useTrainingStore'
import { useHubTransferStore } from '@/domains/hub/store/useHubTransferStore'
import { LossCurvePanel } from '@/domains/training/components/LossCurvePanel'
import { TrainingProgressPanel } from '@/domains/training/components/TrainingProgressPanel'
import { useI18n } from '@/i18n'
import { useAuthStore } from '@/shared/lib/authStore'
import { postJson } from '@/shared/api/client'

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
const REMOTE_TRAINING_START = '/api/train/remote/start'
const REMOTE_WAITING_MESSAGE = '等待服务器响应'

type RemoteTrainingTask = {
  taskName: string
  status: string
}

declare global {
  var webterminal_url: string
}

export default function TrainingCenterPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const datasets = useDatasetsStore((state) => state.datasets)
  const loadDatasets = useDatasetsStore((state) => state.loadDatasets)
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
  const runtimeDatasets = datasets.filter((dataset) => dataset.capabilities.can_train && dataset.runtime)

  const [trainDataset, setTrainDataset] = useState('')
  const [policyType, setPolicyType] = useState('act')
  const [trainSteps, setTrainSteps] = useState(100000)
  const [trainDevice, setTrainDevice] = useState('cuda')
  const [pullPolicyRepo, setPullPolicyRepo] = useState('')
  const trainingMode: TrainingMode = location.pathname.startsWith('/training/remote') ? 'remote' : 'local'
  const [remoteDatasetPath, setRemoteDatasetPath] = useState('')
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
  const [remoteCreateMessage, setRemoteCreateMessage] = useState('')
  const [webTerminalUrl, setWebTerminalUrl] = useState('')
  const [selectedRemoteTaskName, setSelectedRemoteTaskName] = useState('')
  const remoteTaskNames = Object.keys(remoteTasks)
  const remoteTaskCount = Object.keys(remoteTasks).length

  useEffect(() => {
    void loadDatasets()
    void loadPolicies()
    void restoreCurrentTrainJob()
  }, [loadDatasets, loadPolicies, restoreCurrentTrainJob])

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
      datasetPath.length > 150 ||
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
        datasetPath,
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
      }) as { message?: string; tasks?: RemoteTrainingTask[] }
      const nextTasks = Object.fromEntries((response.tasks || []).map(task => [task.taskName, task]))
      setRemoteTasks(nextTasks)
      if (selectedRemoteTaskName && !nextTasks[selectedRemoteTaskName]) setSelectedRemoteTaskName('')
      setRemoteServerConnected(response.message === 'sync success')
      setRemoteCreateMessage(response.message === 'sync success' ? '同步成功' : '同步失败')
    } finally {
      setRemoteTrainingPending(false)
    }
  }

  return (
    <div className="page-enter flex flex-col h-full overflow-y-auto">
      <div className="border-b border-bd/50 px-6 py-4 bg-sf flex items-center justify-between gap-4">
        <h2 className="text-xl font-bold tracking-tight">{t('trainingCenter')}</h2>
      </div>

      {trainingMode === 'remote' ? (
        <div className="flex-1 p-6">
          {isLoggedIn ? (
            <div className="space-y-6">
              <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-gn">
                <div className="flex items-center justify-between gap-4">
                  <h3 className="text-sm font-bold text-tx uppercase tracking-wide">服务器连接状态</h3>
                  <div className="flex items-center gap-2 text-sm text-tx2">
                    <span
                      className={`h-2.5 w-2.5 rounded-full ${remoteServerConnected ? 'bg-gn' : 'bg-rd'}`}
                    />
                    <span>{remoteServerConnected ? '已同步' : '未连接'}</span>
                  </div>
                </div>
              </section>

              <section className="bg-sf rounded-xl p-5 shadow-card shadow-inset-yl">
                <h3 className="text-sm font-bold text-tx uppercase tracking-wide mb-4">训练参数</h3>
                <div className="grid grid-cols-2 gap-4 max-[760px]:grid-cols-1">
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono col-span-2 max-[760px]:col-span-1">
                    数据集路径
                    <input
                      value={remoteDatasetPath}
                      maxLength={150}
                      onChange={(e) => setRemoteDatasetPath(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    训练轮次
                    <input
                      type="number"
                      min={1}
                      max={10000000}
                      value={remoteEpochs}
                      onChange={(e) => setRemoteEpochs(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    存档轮次
                    <input
                      type="number"
                      min={1}
                      max={10000000}
                      value={remoteCheckpointEpochs}
                      onChange={(e) => setRemoteCheckpointEpochs(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    训练任务名称
                    <input
                      value={remoteTaskName}
                      maxLength={150}
                      pattern="[A-Za-z0-9]{1,150}"
                      onChange={(e) => setRemoteTaskName(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    GPU数量
                    <input
                      type="number"
                      min={1}
                      value={remoteGpuCount}
                      onChange={(e) => setRemoteGpuCount(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    GPU类型
                    <input
                      value={remoteGpuType}
                      onChange={(e) => setRemoteGpuType(e.target.value)}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base focus:outline-none focus:border-ac"
                    />
                  </label>
                  <label className="flex flex-col gap-1.5 text-sm text-tx3 font-mono">
                    Batch 大小
                    <select
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
                      type="number"
                      min={1}
                      value={remoteLogFreq}
                      onChange={(e) => setRemoteLogFreq(clampNumber(e.target.value, 1, 10000000))}
                      className="h-10 bg-bg border border-bd text-tx px-3 rounded-lg text-base font-mono focus:outline-none focus:border-ac"
                    />
                  </label>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
                  <label className="flex w-full items-center gap-2 text-sm text-tx2">
                    <span className="shrink-0">当前任务</span>
                    <select
                      value={selectedRemoteTaskName}
                      onChange={(e) => setSelectedRemoteTaskName(e.target.value)}
                      className="h-10 min-w-0 flex-1 bg-bg border border-bd text-tx px-3 rounded-lg text-sm focus:outline-none focus:border-ac"
                    >
                      <option value="">请选择任务</option>
                      {remoteTaskNames.map(name => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                  <div className="grid grid-cols-2 gap-4 max-[520px]:grid-cols-1">
                    <div className="h-10 w-full px-3 rounded-lg border border-bd/40 bg-bg text-sm text-tx2 flex items-center justify-center">
                      当前任务数量：{remoteTaskCount}
                    </div>
                    <button
                      type="button"
                      disabled={remoteTrainingPending}
                      onClick={syncRemoteTasks}
                      className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-ac bg-ac/10 hover:bg-ac/20
                        transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                    >
                      任务同步
                    </button>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-4 gap-3 max-[900px]:grid-cols-2 max-[520px]:grid-cols-1">
                  <button
                    disabled={remoteTrainingPending}
                    onClick={startRemoteTraining}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2 shadow-glow-ac
                      transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed disabled:shadow-none"
                  >
                    {remoteTrainingPending ? '创建中...' : '开始训练'}
                  </button>
                  <button
                    disabled={remoteTrainingPending || !selectedRemoteTaskName}
                    onClick={() => {
                      if (confirm('该操作将会停止当前的训练任务')) void endRemoteTraining()
                    }}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-rd hover:bg-rd/90
                      transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    终止任务
                  </button>
                  <button
                    disabled={remoteTrainingPending || !selectedRemoteTaskName}
                    onClick={() => {
                      if (confirm('删除任务会导致训练任务的结果被删除，是否继续？')) void deleteRemoteTraining()
                    }}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-rd hover:bg-rd/90
                      transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    删除任务
                  </button>
                  <button
                    disabled={remoteTrainingPending || !selectedRemoteTaskName}
                    onClick={queryRemoteTaskStatus}
                    className="h-10 w-full px-4 rounded-lg text-sm font-semibold text-ac bg-ac/10 hover:bg-ac/20
                      transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                  >
                    查询状态
                  </button>
                </div>
                <button
                  type="button"
                  disabled={!webTerminalUrl}
                  onClick={() => navigate('/training/remote/terminal')}
                  className="mt-3 h-10 w-full px-4 rounded-lg text-sm font-semibold text-white bg-ac hover:bg-ac2
                    transition-all active:scale-[0.97] disabled:opacity-25 disabled:cursor-not-allowed"
                >
                  打开终端
                </button>
                {remoteCreateMessage && (
                  <div className="mt-4 rounded-lg border border-bd/70 bg-bg px-4 py-3">
                    <div className="mb-2 text-sm font-semibold text-tx">服务器请求结果</div>
                    <div className="whitespace-pre-wrap break-words text-base leading-6 text-tx2">{remoteCreateMessage}</div>
                  </div>
                )}
              </section>
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
              <option key={d.id} value={d.runtime!.name}>{d.label}</option>
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
