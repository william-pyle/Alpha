export const workspaceUtilities = {
  'learned-preferences': "What I've learned",
  'common-agents': 'Common agents',
  health: 'Alpha health',
  settings: 'Settings',
  'conversation-history': 'Conversation history',
  'needs-attention': 'Needs attention',
} as const

export type WorkspaceUtility = keyof typeof workspaceUtilities
export const isWorkspaceUtility = (value: unknown): value is WorkspaceUtility => typeof value === 'string' && Object.prototype.hasOwnProperty.call(workspaceUtilities, value)

// Menus, context menus and notifications share a single destination. Opening a
// utility never chooses a project, changes a route or changes the conversation.
export function openWorkspaceUtility(id: WorkspaceUtility) {
  window.dispatchEvent(new CustomEvent('alpha-open-utility', { detail: id }))
}
