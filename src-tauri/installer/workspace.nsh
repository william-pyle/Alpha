!include nsDialogs.nsh
!include LogicLib.nsh
!include FileFunc.nsh

; The test harness overrides these two roots and never installs the application.
!ifndef ALPHA_WORKSPACE_CONFIG
  !define ALPHA_WORKSPACE_CONFIG "$APPDATA\com.jazcosolutions.alpha"
!endif
!ifndef ALPHA_WORKSPACE_DEFAULT
  !define ALPHA_WORKSPACE_DEFAULT "$DOCUMENTS\Alpha"
!endif
Var AlphaWorkspacePath
Var AlphaWorkspaceInput
Var AlphaWorkspaceDialog

Function AlphaWorkspacePageCreate
  IfSilent alpha_workspace_skip
  ${If} $PassiveMode = 1
  ${OrIf} $UpdateMode = 1
    Abort
  ${EndIf}
  ; Upgrades retain the location selected by the application, including pending changes.
  IfFileExists "${ALPHA_WORKSPACE_CONFIG}\repository.json" alpha_workspace_skip
  ${If} $AlphaWorkspacePath == ""
    StrCpy $AlphaWorkspacePath "${ALPHA_WORKSPACE_DEFAULT}"
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Workspace folder" "Choose where Alpha keeps your working files."
  nsDialogs::Create 1018
  Pop $AlphaWorkspaceDialog
  ${If} $AlphaWorkspaceDialog == error
    Abort
  ${EndIf}
  ${NSD_CreateLabel} 0 0 100% 38u "Your Workspace contains cards, project files, local knowledge and Alpha chat history. Choose a new or empty folder, or an existing Alpha Workspace."
  Pop $0
  ${NSD_CreateLabel} 0 45u 100% 12u "Workspace folder:"
  Pop $0
  ${NSD_CreateDirRequest} 0 60u 77% 14u "$AlphaWorkspacePath"
  Pop $AlphaWorkspaceInput
  ${NSD_CreateBrowseButton} 80% 60u 20% 14u "Browse..."
  Pop $0
  ${NSD_OnClick} $0 AlphaWorkspaceBrowse
  ${NSD_CreateLabel} 0 87u 100% 36u "You can change this location later in Settings. Application files are installed separately. Updates keep your Workspace location."
  Pop $0
  nsDialogs::Show
  Return
  alpha_workspace_skip:
  Abort
FunctionEnd

Function AlphaWorkspaceBrowse
  Pop $0
  ${NSD_GetText} $AlphaWorkspaceInput $AlphaWorkspacePath
  nsDialogs::SelectFolderDialog "Choose the Workspace folder" "$AlphaWorkspacePath"
  Pop $0
  ${If} $0 != error
    ${NSD_SetText} $AlphaWorkspaceInput "$0"
  ${EndIf}
FunctionEnd

Function AlphaWorkspacePageLeave
  ${NSD_GetText} $AlphaWorkspaceInput $AlphaWorkspacePath
  ${GetRoot} "$AlphaWorkspacePath" $0
  ${If} $0 == ""
  ${OrIf} $AlphaWorkspacePath == "$0\"
  ${OrIf} $AlphaWorkspacePath == "$0"
    MessageBox MB_ICONEXCLAMATION "Choose a dedicated folder using its full path."
    Abort
  ${EndIf}
  IfFileExists "$AlphaWorkspacePath\workspace\workspace.json" alpha_workspace_valid
  FindFirst $0 $1 "$AlphaWorkspacePath\*"
  alpha_workspace_scan:
    ${If} $1 == ""
      Goto alpha_workspace_empty
    ${EndIf}
    ${If} $1 != "."
    ${AndIf} $1 != ".."
      FindClose $0
      MessageBox MB_ICONEXCLAMATION "This folder already contains files and is not an Alpha Workspace. Choose an empty folder or the root of an existing Workspace."
      Abort
    ${EndIf}
    FindNext $0 $1
    Goto alpha_workspace_scan
  alpha_workspace_empty:
    FindClose $0
  alpha_workspace_valid:
FunctionEnd

!macro NSIS_HOOK_POSTINSTALL
  ; Never overwrite a saved location during reinstall, silent update or repair.
  ${IfNot} ${FileExists} "${ALPHA_WORKSPACE_CONFIG}\repository.json"
    ${If} $AlphaWorkspacePath == ""
      ; Silent fresh installation uses Documents; an older unregistered Workspace is retained.
      nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\runtime\service\workspace-location.mjs" --config "${ALPHA_WORKSPACE_CONFIG}" --default "${ALPHA_WORKSPACE_DEFAULT}" --legacy "${ALPHA_WORKSPACE_CONFIG}\Workspace" --app-dir "$INSTDIR"'
    ${Else}
      nsExec::ExecToStack '"$INSTDIR\runtime\node.exe" "$INSTDIR\runtime\service\workspace-location.mjs" --config "${ALPHA_WORKSPACE_CONFIG}" --repo "$AlphaWorkspacePath" --app-dir "$INSTDIR"'
    ${EndIf}
    Pop $0
    Pop $1
    ${If} $0 != 0
      IfSilent +2
      MessageBox MB_ICONSTOP "Alpha could not prepare the Workspace folder. No existing Workspace was replaced.$\r$\n$\r$\n$1"
      SetErrorLevel 1
      Abort "Could not prepare Workspace folder."
    ${EndIf}
  ${EndIf}
!macroend
