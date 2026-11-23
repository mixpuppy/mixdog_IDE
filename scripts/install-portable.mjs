// Installs the freshly built portable EXE for daily use (run after `npm run dist`, see `npm run patch`):
//   %LOCALAPPDATA%\Programs\mixdog-IDE-portable\mixdog IDE.exe   <- replaced on every patch
//   Desktop\mixdog IDE.lnk                                          <- shortcut, created once
// A shortcut (instead of the EXE itself on the Desktop) avoids Windows showing a stale cached icon.
import { copyFileSync, readdirSync, statSync, mkdirSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import { execFileSync } from 'child_process'

const dist = join(import.meta.dirname, '..', 'dist')
const built = readdirSync(dist)
  .filter((f) => /^mixdog-IDE-.*-portable\.exe$/.test(f))
  .map((f) => join(dist, f))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
if (!built) {
  console.error('dist 에 portable EXE 가 없습니다. 먼저 npm.cmd run dist 를 실행하세요.')
  process.exit(1)
}

const ps = (cmd) => execFileSync('powershell.exe', ['-NoProfile', '-Command', cmd], { encoding: 'utf-8' }).trim()
const appDir = join(process.env.LOCALAPPDATA, 'Programs', 'mixdog-IDE-portable')
const target = join(appDir, 'mixdog IDE.exe')
mkdirSync(appDir, { recursive: true })

try {
  copyFileSync(built, target)
} catch (e) {
  if (e.code === 'EBUSY' || e.code === 'EPERM') {
    console.error('mixdog IDE 가 실행 중이라 바꿀 수 없습니다. 창을 모두 닫고 다시 실행하세요: npm.cmd run patch:copy')
    process.exit(2)
  }
  throw e
}
console.log(`설치 완료: ${target}`)

// the real Desktop folder (may be redirected to OneDrive)
const desktop = ps("[Environment]::GetFolderPath('Desktop')")
const lnk = join(desktop, 'mixdog IDE.lnk')
if (!existsSync(lnk)) {
  const q = (s) => s.replace(/'/g, "''")
  ps(
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${q(lnk)}'); ` +
      `$s.TargetPath = '${q(target)}'; $s.WorkingDirectory = '${q(appDir)}'; ` +
      `$s.IconLocation = '${q(target)},0'; $s.Description = 'mixdog IDE'; $s.Save()`
  )
  console.log(`바탕화면 바로가기: ${lnk}`)
}

// the old setup copied the EXE itself to the Desktop; the shortcut replaces it
const oldExe = join(desktop, 'mixdog IDE.exe')
if (existsSync(oldExe)) {
  try {
    rmSync(oldExe)
    console.log('바탕화면의 예전 EXE 를 지웠습니다 (바로가기로 대체)')
  } catch {
    console.log('바탕화면의 예전 EXE 가 실행 중이라 지우지 못했습니다. IDE 를 닫은 뒤 직접 지워도 됩니다.')
  }
}
