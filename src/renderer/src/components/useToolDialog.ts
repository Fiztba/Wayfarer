import { useEffect, useRef } from 'react'

export function useToolDialog(onClose: () => void, busy = false) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => {
    const panel = ref.current
    if (!panel) return
    const previous = document.activeElement as HTMLElement | null
    if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('input,button,select')?.focus()
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) { event.preventDefault(); onClose() }
      if (event.key !== 'Tab') return
      const nodes = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),[tabindex="0"]')].filter((e) => e.getClientRects().length > 0 && !e.matches(':disabled'))
      if (!nodes.length) { event.preventDefault(); return }
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler); if (!document.contains(panel)) previous?.focus() }
  }, [onClose, busy])
  return ref
}
