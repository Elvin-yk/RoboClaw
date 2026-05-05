import type { ReactNode } from 'react'

interface SettingsPageFrameProps {
    children: ReactNode
}

export default function SettingsPageFrame({
    children,
}: SettingsPageFrameProps) {
    return (
        <div className="page-enter flex flex-col h-full overflow-y-auto">
            <div className="flex-1 w-full px-6 py-6 2xl:px-10">
                {children}
            </div>
        </div>
    )
}
