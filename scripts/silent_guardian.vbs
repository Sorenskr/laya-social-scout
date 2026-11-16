Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
rootDir = fso.GetParentFolderName(scriptDir)
guardianJs = fso.BuildPath(rootDir, "daemon_guardian.js")

Set objShell = CreateObject("WScript.Shell")
shellNode = ""
candidates = Array( _
  "D:\Program Files (x86)\node.exe", _
  objShell.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe"), _
  objShell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\nodejs\node.exe"), _
  objShell.ExpandEnvironmentStrings("%USERPROFILE%\.workbuddy\binaries\node\versions\22.22.2-6\node.exe"), _
  "node" _
)

For Each c In candidates
  If c = "node" Or fso.FileExists(c) Then
    shellNode = c
    Exit For
  End If
Next

objShell.CurrentDirectory = rootDir
objShell.Run """" & shellNode & """ """ & guardianJs & """", 0, False
