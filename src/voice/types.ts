export interface DictationInfo { available: boolean; provider: string | null; providers?: { id: string; label: string; available: boolean; detail: string }[]; maxSeconds: number; maxBytes: number }
