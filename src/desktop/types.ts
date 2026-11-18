export type AgentId = 'codex' | 'claude' | 'shell' | 'gitbash'
export interface AgentInfo { id: AgentId; label: string; color: string; available: boolean; subscription: boolean }
export interface ChatSession {
  workerEvidence?: { taskId: string; nativeTaskId?: string; deliveredAt?: number; acceptance: string; execution: string; verification: string; certainty: string; source: string; revision: number; observedAt: number }
  projectId?: string | null; projectPending?: boolean
  id: string; name: string; agent: AgentId; cwd: string; bypass: boolean
  effort?: 'medium' | 'high' | 'xhigh' | 'max'
  status: 'starting' | 'running' | 'stopped' | 'exited'; createdAt: string
  lastOutputAt: string | null; lastInputAt: string | null; nativeId: string | null
  attention: boolean; cols: number; rows: number; exitCode?: number | null
  activity: 'idle' | 'working' | 'waiting'; unread: boolean; completionVersion: number
  tabOrder: number; tabColor: string | null
  open: boolean; pinned: boolean; updatedAt: string; preview?: string; hasConversation?: boolean; restoreError?: string | null
}
export interface Notice { id: string; sessionId: string; name: string; kind: string; text: string; at: string }
export interface ChatQuestion { threadId?: string; id: string; sessionId: string; source?: 'coordinator' | 'maintenance' | 'project'; chatName: string; text: string; options: string[]; status: 'pending'; createdAt: string }
export interface Operation { threadId?: string | null; id: string; text: string; status: string; result?: string; at: string; images?: string[]; origin?: string }
export interface ThemeProfile { id: string; label: string; controller: string; icon: string; backdrop: string; background: string; foreground: string; accent: string }
export interface Settings { readingSize?: number; readingSpacing?: number; reducedMotion?: boolean; workspaceFilters?: { scope: 'active' | 'archived' | 'all'; category: string; query: string }; viewerEnabled?: boolean; viewerHeight?: number; composerHeight?: number; appTheme?: string; themeProfiles?: ThemeProfile[]; defaultAgent: AgentId; transcribeProvider?: 'local' | 'openai' | 'openrouter' | 'off'; defaultBypass: boolean; terminalFontSize?: number; terminalAppearance?: 'focus' | 'original'; workspaceTheme?: 'dark' | 'light' | 'system'; workspaceRoute?: string | null; selectedId?: string | null; chatSidebarWidth?: number; chatEditorHeights?: Record<string, number>; coordinatorEffort?: 'medium' | 'high'; voiceName?: string; voiceStyle?: string; conversationStyle?: string; speakReplies?: boolean; speechVoice?: string }
export interface AgentReply { id: string; sessionId: string; name: string; text: string; at: string }
export interface SpeechState { speaking: boolean; error: string | null; threadId?: string | null; level?: number; levelAt?: number; durationMs?: number; source?: string; phase?: string }
export interface PhaseTimings { queuedAt: number; dequeuedAt?: number; readyAt?: number; submittedAt?: number; acceptedAt?: number; firstTextAt?: number; completedAt?: number; toolMs?: number; toolCalls?: number }
export interface ThreadMessage { completionSummary?: { changed: string[]; passed: { text: string; evidence: string }[]; remaining: string[]; lifecycle: Record<string, { status: string; evidence: string | null }>; source: string; verification: string; operationId: string; at: string }; id: string; role: 'user' | 'assistant'; text: string; at: string; status?: string; images?: string[]; error?: string; source?: string; timings?: PhaseTimings }
export interface AlphaThread { allowUiInspection?: boolean; operation?: { id: string; phase: string; timings: PhaseTimings }; draft?: { text: string; paths: string[] }; id: string; kind: 'alpha' | 'native'; name: string; purpose: string; projectId: string | null; projectPending: boolean; sessionIds: string[]; messages: ThreadMessage[]; messageCount?: number; status: string; archived: boolean; unread: boolean; desktopContext?: boolean; nativeHistoryImported?: { count: number } }
export interface AwarenessState { settings: { enabled: boolean; quiet: boolean; desktop: boolean }; desktop: { application: string; source: string; at: number } | null; items: { id: string; threadId: string | null; questionId?: string | null; sessionId?: string | null; kind: string; text: string; source: string; inference: boolean; at: number }[] }
export interface VoiceOwner { clientId: string; surface: 'chats' | 'workspace' }
export interface FileEntry { name: string; path: string; directory: boolean; size: number; modifiedAt: string | null }
export interface Folder { path: string; parent: string; entries: FileEntry[]; truncated: boolean; mode: string }
export interface Preview { path: string; name: string; size: number; kind: 'document' | 'image' | 'video' | 'audio' | 'text' | 'unsupported'; url?: string; text?: string; revision?: string; reason?: string }
export interface NativeWindowState { available: boolean; maximized: boolean; minimized: boolean; error?: string | null }
export interface DesktopState {
  nativeWindow?: NativeWindowState
  threads: AlphaThread[]; selectedThreadId: string | null; awareness: AwarenessState
  sharedLibrary?: { root: string; version: string; skills: string[]; files: number; conflicts: { path: string; reason: string; incoming: string }[] } | null
  ready: boolean; connected: boolean; error: string | null; repo: string; contentBase: string
  agents: AgentInfo[]; sessions: ChatSession[]; selectedId: string | null; notices: Notice[]; questions: ChatQuestion[]
  settings: Settings; coordinator: string; voice: { configured: boolean; owner: VoiceOwner | null }
  operations: Operation[]; preview: Preview | null
  replies: AgentReply[]; speech: SpeechState
  voiceHistory: { id: string; at: string; captions: { role: 'user' | 'assistant'; text: string; start: number; end: number }[] }[]
}
export interface ServiceEvent { inspectionId?: string;
  nativeWindow?: NativeWindowState
  threads?: AlphaThread[]; selectedThreadId?: string | null; awareness?: AwarenessState; threadId?: string; text?: string
  type: string; id?: string; cardId?: string; data?: string; sequence?: number; session?: ChatSession; sessions?: ChatSession[]
  selectedId?: string; sessionId?: string; state?: string; error?: string; notice?: Notice
  operation?: Operation; settings?: Settings; owner?: VoiceOwner | null; window?: string; route?: string; preview?: Preview; questions?: ChatQuestion[]
  reply?: AgentReply; speech?: SpeechState
}
