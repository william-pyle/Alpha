export type Theme = {
  id: string;
  name: string;
  displayName: string;
  controller: string;
  avatar: string;
  background: string;
  surface: string;
  raised: string;
  accent: string;
  secondary: string;
  text: string;
  muted: string;
  border: string;
  atmosphere: string;
  backdrop: string;
};
export type Project = {
  id: string;
  name: string;
  themeId: string;
  created: string;
  workspaces: { id: string; name: string }[];
};
export type RecordItem = {
  id: string;
  kind: "knowledge" | "skill";
  title: string;
  content: string;
  scope: "alpha" | "project";
  projectId: string | null;
  tags: string[];
  importance: number;
  pinned: boolean;
  links: string[];
  source: string;
  created: string;
  updated: string;
};
export type Session = {
  id: string;
  projectId: string;
  workspaceId: string;
  provider: string;
  title: string;
  status: string;
  created: string;
  contextIds: string[];
  task: string;
  exitCode?: number;
};
export type Message = {
  id: string;
  from: string;
  to: string;
  body: string;
  created: string;
  read: boolean;
};
export type Question = {
  id: string;
  text: string;
  context: string;
  options: string[];
  projectId: string | null;
  requester: string;
  area: string;
  status: "pending" | "answered" | "resolved";
  answer: string | null;
  created: string;
  answeredAt: string | null;
};
export type Snapshot = {
  projects: Project[];
  records: RecordItem[];
  sessions: Session[];
  themes: Theme[];
  messages: Message[];
  questions: Question[];
  settings: {
    themeId: string;
    activeProjectId: string | null;
    layout: string;
    viewerMode: string;
    viewerTab: string;
  };
  providers: { id: string; label: string; available: boolean }[];
};
export type Recall = {
  items: (RecordItem & { score: number; reason: string })[];
  text: string;
  usedTokens: number;
  budget: number;
  elapsedMs: number;
  omittedPinned: string[];
};
export interface AlphaApi {
  snapshot: () => Promise<Snapshot>;
  action: (type: string, payload?: any) => Promise<any>;
  terminalInput: (id: string, data: string) => void;
  terminalResize: (id: string, cols: number, rows: number) => void;
  onState: (fn: (state: Snapshot) => void) => () => void;
  onTerminal: (
    fn: (data: { id: string; data: string; seq: number }) => void,
  ) => () => void;
}
declare global {
  interface Window {
    alpha: AlphaApi;
  }
}
