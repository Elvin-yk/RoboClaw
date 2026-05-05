import { useEffect } from 'react'
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom'
import AppShell from '@/app/shell/AppShell'
import ControlPage from '@/domains/control/pages/ControlPage'
import TaskPublishPage from '@/domains/collection/pages/TaskPublishPage'
import RecoveryCenterPage from '@/domains/recovery/pages/RecoveryCenterPage'
import DatasetExplorerPage from '@/domains/datasets/explorer/pages/DatasetExplorerPage'
import DataWorkshopPage from '@/domains/data-workshop/pages/DataWorkshopPage'
import TrainingCenterPage from '@/domains/training/pages/TrainingCenterPage'
import QualityValidationPage from '@/domains/curation/quality/pages/QualityValidationPage'
import TextAlignmentPage from '@/domains/curation/text-alignment/pages/TextAlignmentPage'
import DataOverviewPage from '@/domains/curation/data-overview/pages/DataOverviewPage'
import HardwareSettingsPage from '@/domains/settings/pages/HardwareSettingsPage'
import ProviderSettingsPage from '@/domains/settings/pages/ProviderSettingsPage'
import HubSettingsPage from '@/domains/settings/pages/HubSettingsPage'
import AccountSettingsPage from '@/domains/settings/pages/AccountSettingsPage'
import LogsPage from '@/domains/logs/pages/LogsPage'
import LoginPage from '@/domains/auth/pages/LoginPage'
import { useAuthStore } from '@/shared/lib/authStore'

function RequireLogin() {
    const isChecking = useAuthStore((state) => state.isChecking)
    const isLoggedIn = useAuthStore((state) => state.isLoggedIn)

    if (isChecking) {
        return (
            <div className="collection-page">
                <div className="collection-empty">Checking account...</div>
            </div>
        )
    }
    if (!isLoggedIn) {
        return <Navigate to="/login" replace />
    }
    return <Outlet />
}

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

                {/* 主应用：必须登录后才能访问 */}
                <Route element={<RequireLogin />}>
                    <Route path="/" element={<AppShell />}>
                        <Route index element={<Navigate to="/collection/control" replace />} />
                        <Route path="collection" element={<Navigate to="/collection/control" replace />} />
                        <Route path="collection/control" element={<ControlPage />} />
                        <Route path="collection/publish" element={<TaskPublishPage />} />
                        <Route path="collection/recovery" element={<RecoveryCenterPage />} />
                        <Route path="datasets" element={<Navigate to="/curation/datasets" replace />} />
                        <Route path="datasets/explorer" element={<Navigate to="/curation/datasets" replace />} />
                        <Route path="training" element={<TrainingCenterPage />} />
                        <Route path="curation" element={<Navigate to="/curation/workshop" replace />} />
                        <Route path="curation/workshop" element={<DataWorkshopPage />} />
                        <Route path="curation/datasets" element={<DatasetExplorerPage />} />
                        <Route path="curation/datasets/explorer" element={<Navigate to="/curation/datasets" replace />} />
                        <Route path="curation/quality" element={<QualityValidationPage />} />
                        <Route path="curation/text-alignment" element={<TextAlignmentPage />} />
                        <Route path="curation/data-overview" element={<DataOverviewPage />} />
                        <Route path="settings" element={<Navigate to="/settings/hardware" replace />} />
                        <Route path="settings/hardware" element={<HardwareSettingsPage />} />
                        <Route path="settings/provider" element={<ProviderSettingsPage />} />
                        <Route path="settings/hub" element={<HubSettingsPage />} />
                        <Route path="settings/account" element={<AccountSettingsPage />} />
                        <Route path="logs" element={<LogsPage />} />
                    </Route>
                </Route>
            </Routes>
        </BrowserRouter>
    )
}

export default App
