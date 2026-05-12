import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

type TerminalMessage = {
  operation?: string
  data?: string
}

function terminalUrl(): string {
  return sessionStorage.getItem('webterminal_url') || globalThis.webterminal_url || ''
}

export default function WebTerminalPage() {
  const terminalRef = useRef<HTMLDivElement | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [hasUrl] = useState(() => terminalUrl().startsWith('wss://'))
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    const url = terminalUrl()
    if (!url || !url.startsWith('wss://')) {
      return
    }

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#080b12',
        foreground: '#d8e2f0',
      },
    })
    const fitAddon = new FitAddon()
    fitAddonRef.current = fitAddon
    terminal.loadAddon(fitAddon)
    terminal.open(terminalRef.current!)
    fitAddon.fit()

    const socket = new WebSocket(url)
    socketRef.current = socket

    function sendResize() {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({
        operation: 'resize',
        rows: terminal.rows,
        cols: terminal.cols,
      }))
    }

    socket.onopen = () => {
      sendResize()
      terminal.focus()
    }
    socket.onerror = () => setExpired(true)
    socket.onclose = () => {
      if (socket.readyState !== WebSocket.OPEN) setExpired(true)
    }
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data) as TerminalMessage
      if (message.operation === 'stdout' || message.operation === 'stderr') {
        terminal.write(message.data || '')
      }
    }

    const dataDisposable = terminal.onData((data) => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ operation: 'stdin', data }))
    })
    const resize = () => {
      fitAddon.fit()
      sendResize()
    }
    window.addEventListener('resize', resize)

    return () => {
      window.removeEventListener('resize', resize)
      dataDisposable.dispose()
      socket.close()
      terminal.dispose()
    }
  }, [])

  if (!hasUrl) {
    return <div className="h-full bg-bg" />
  }

  if (expired) {
    return (
      <div className="flex h-full items-center justify-center bg-bg p-6">
        <div className="rounded-xl border border-bd bg-sf px-6 py-5 text-sm font-semibold text-rd">
          容器链接已过期
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#080b12]">
      <div className="border-b border-white/10 px-4 py-2 text-sm font-semibold text-white">
        容器终端
      </div>
      <div ref={terminalRef} className="min-h-0 flex-1 p-3" />
    </div>
  )
}
