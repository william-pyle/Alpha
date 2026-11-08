import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import os from "node:os";
import { parse } from "smol-toml";

export function existingCodexInstructions() {
  const home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    file = path.join(home, "config.toml");
  if (!fs.existsSync(file)) return "";
  try {
    const config = parse(fs.readFileSync(file, "utf8"));
    let text =
      typeof config.developer_instructions === "string"
        ? config.developer_instructions
        : "";
    if (
      typeof config.profile === "string" &&
      /^[a-zA-Z0-9_-]+$/.test(config.profile)
    ) {
      const profileFile = path.join(home, config.profile + ".config.toml");
      const profile = fs.existsSync(profileFile)
        ? parse(fs.readFileSync(profileFile, "utf8"))
        : config.profiles?.[config.profile];
      if (typeof profile?.developer_instructions === "string")
        text = profile.developer_instructions;
    }
    return text;
  } catch {
    return null;
  } // Preserve provider handling of an unreadable configuration.
}

function executable(command, candidates = []) {
  try {
    const result = execFileSync("where.exe", [command], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .trim()
      .split(/\r?\n/);
    candidates.push(...result);
  } catch {}
  return (
    candidates.find(
      (p) => p && fs.existsSync(p) && /\.(exe|cmd|bat)$/i.test(p),
    ) || null
  );
}
export function detectProviders() {
  const local = process.env.LOCALAPPDATA || "",
    home = process.env.USERPROFILE || "";
  return [
    {
      id: "codex",
      label: "Codex",
      path: executable("codex", [
        path.join(local, "Programs/OpenAI/Codex/bin/codex.exe"),
      ]),
    },
    {
      id: "claude",
      label: "Claude Code",
      path: executable("claude", [path.join(home, ".local/bin/claude.exe")]),
    },
    {
      id: "powershell",
      label: "PowerShell",
      path:
        executable("pwsh") ||
        executable("powershell", [
          path.join(
            process.env.SystemRoot || "C:/Windows",
            "System32/WindowsPowerShell/v1.0/powershell.exe",
          ),
        ]),
    },
    {
      id: "gitbash",
      label: "Git Bash",
      path: executable("bash", [
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
      ]),
    },
  ].map((p) => ({ ...p, available: Boolean(p.path) }));
}
export function providerArguments(
  provider,
  {
    bridge,
    node,
    endpoint,
    token,
    prompt,
    resume = false,
    existingInstructions = "",
  },
) {
  const instructions =
    "You are working inside Alpha. Use alpha_recall at the start of a task and when its focus changes; only retrieve knowledge needed for that task. Use alpha_remember to retain reusable learned knowledge, and mark facts specific to this project as project-specific. Use alpha_skills to discover shared and current-project skills. Use alpha_windows, alpha_send_message and alpha_inbox to coordinate with windows in this project. Questions for the human go through alpha_ask_question and alpha_questions; hold dependent work until an actual answer exists, continue independent work, and mark answered questions resolved after applying the answer. Never treat a suggested option as an answer.";
  const env = {
    ALPHA_ENDPOINT: endpoint,
    ALPHA_SESSION_TOKEN: token,
    ELECTRON_RUN_AS_NODE: "1",
  };
  const workflow =
    instructions +
    " Use com.jazcosolutions as the default namespace prefix for anything created for or by Alpha, including applications, packages and integrations, unless the human specifies another.";
  if (provider === "codex")
    return [
      "-c",
      `mcp_servers.alpha.command=${JSON.stringify(node)}`,
      "-c",
      `mcp_servers.alpha.args=${JSON.stringify([bridge])}`,
      "-c",
      `mcp_servers.alpha.env={ ALPHA_ENDPOINT=${JSON.stringify(endpoint)}, ALPHA_SESSION_TOKEN=${JSON.stringify(token)}, ELECTRON_RUN_AS_NODE="1" }`,
      ...(existingInstructions === null
        ? []
        : [
            "-c",
            `developer_instructions=${JSON.stringify([existingInstructions, workflow].filter(Boolean).join("\n\n"))}`,
          ]),
      ...(resume
        ? ["resume"]
        : prompt
          ? [
              existingInstructions === null
                ? workflow + "\n\n" + prompt
                : prompt,
            ]
          : []),
    ];
  if (provider === "claude")
    return [
      "--mcp-config",
      JSON.stringify({
        mcpServers: { alpha: { command: node, args: [bridge], env } },
      }),
      "--append-system-prompt",
      workflow,
      ...(resume ? ["--resume"] : prompt ? [prompt] : []),
    ];
  if (provider === "powershell") return ["-NoLogo"];
  return ["--login", "-i"];
}
