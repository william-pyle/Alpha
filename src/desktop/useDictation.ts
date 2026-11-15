import { useCallback, useEffect, useState } from 'react'
import { api, onServiceEvent } from './client'
import type { DictationInfo } from '../voice/types'

export function useDictation() {
  const [info, setInfo] = useState<DictationInfo>()
  const refresh = useCallback(async () => { const next = await api<DictationInfo>('/dictation'); setInfo(next); return next }, [])
  useEffect(() => {
    let alive = true, generation = 0
    const update = () => { const current = ++generation; void api<DictationInfo>('/dictation').then(info => { if (alive && current === generation) setInfo(info) }).catch(() => {}) }
    update()
    const off = onServiceEvent(event => { if (event.type === 'dictation' || event.type === 'connected') update() })
    return () => { alive = false; off() }
  }, [])
  const choose = useCallback(async (provider: string) => { const info = await api<DictationInfo>('/dictation', { provider }); setInfo(info); return info }, [])
  return { info, choose, refresh, setInfo }
}
