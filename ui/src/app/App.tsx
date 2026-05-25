import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AppShell from '@/app/shell/AppShell'
import ControlPage from '@/domains/control/pages/ControlPage'
import TaskPublishPage from '@/domains/collection/pages/TaskPublishPage'
import DataAnalysisPage from '@/domains/data/pages/DataAnalysisPage'
import DataAnnotationPage from '@/domains/data/pages/DataAnnotationPage'
import DataMarketPage from '@/domains/data/pages/DataMarketPage'
import DataManagePage from '@/domains/data/pages/DataManagePage'
import DataQcPage from '@/domains/data/pages/DataQcPage'
import TrainingCenterPage from '@/domains/training/pages/TrainingCenterPage'
import WebTerminalPage from '@/domains/training/pages/WebTerminalPage'
import CreditsPage from '@/domains/credits/pages/CreditsPage'
import HardwareSettingsPage from '@/domains/settings/pages/HardwareSettingsPage'
import ProviderSettingsPage from '@/domains/settings/pages/ProviderSettingsPage'
import HubSettingsPage from '@/domains/settings/pages/HubSettingsPage'
import AccountSettingsPage from '@/domains/settings/pages/AccountSettingsPage'
import LogsPage from '@/domains/logs/pages/LogsPage'
import LoginPage from '@/domains/auth/pages/LoginPage'
import { useAuthStore } from '@/shared/lib/authStore'

function App() {
    const initialize = useAuthStore((state) => state.initialize)

    // 应用启动时异步验证 token，不阻塞渲染
    useEffect(() => {
        void initialize()
    }, [initialize])

    return (
        <BrowserRouter>
            <Routes>
                {/* 登录页：独立全屏，不使用 AppShell */}
                <Route path="/login" element={<LoginPage />} />

                {/* 主应用默认使用本地匿名会话；云端登录只是可选能力。 */}
                <Route path="/" element={<AppShell />}>
                    <Route index element={<Navigate to="/collection/control" replace />} />
                    <Route path="collection" element={<Navigate to="/collection/control" replace />} />
                    <Route path="collection/control" element={<ControlPage />} />
                    <Route path="collection/publish" element={<TaskPublishPage />} />
                    <Route path="training" element={<Navigate to="/training/local" replace />} />
                    <Route path="training/local" element={<TrainingCenterPage />} />
                    <Route path="training/remote" element={<TrainingCenterPage />} />
                    <Route path="training/remote/terminal" element={<WebTerminalPage />} />
                    <Route path="data" element={<Navigate to="/data/manage" replace />} />
                    <Route path="data/analysis" element={<DataAnalysisPage />} />
                    <Route path="data/annotation" element={<DataAnnotationPage />} />
                    <Route path="data/market" element={<DataMarketPage />} />
                    <Route path="data/manage" element={<DataManagePage />} />
                    <Route path="data/qc" element={<DataQcPage />} />
                    <Route path="settings" element={<Navigate to="/settings/hardware" replace />} />
                    <Route path="settings/hardware" element={<HardwareSettingsPage />} />
                    <Route path="settings/provider" element={<ProviderSettingsPage />} />
                    <Route path="settings/hub" element={<HubSettingsPage />} />
                    <Route path="settings/account" element={<AccountSettingsPage />} />
                    <Route path="settings/credits" element={<CreditsPage />} />
                    <Route path="logs" element={<LogsPage />} />
                </Route>
            </Routes>
        </BrowserRouter>
    )
}

export default App
