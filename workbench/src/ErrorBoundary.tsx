import { Component, type ErrorInfo, type ReactNode } from 'react'

type ErrorBoundaryProps = {
  children: ReactNode
}

type ErrorBoundaryState = {
  failed: boolean
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Workbench render failed', error, info)
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error">
          <div>
            <span>APERTURE RECOVERY</span>
            <h1>工作台遇到渲染错误</h1>
            <p>页面状态已被隔离，不会影响任何外部项目数据。重新加载后可以继续。</p>
            <button onClick={() => window.location.reload()}>重新加载工作台</button>
          </div>
        </main>
      )
    }

    return this.props.children
  }
}
