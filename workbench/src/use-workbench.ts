import { useContext } from 'react'
import { WorkbenchContext } from './workbench-context'

export function useWorkbench() {
  const context = useContext(WorkbenchContext)
  if (!context) throw new Error('useWorkbench must be used within WorkbenchProvider')
  return context
}
