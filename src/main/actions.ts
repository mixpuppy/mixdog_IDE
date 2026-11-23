/**
 * High-level IDE actions shared by the UI (IPC) and the AI (MCP tools),
 * so "user clicks Run" and "Claude runs the app" are the same code path.
 */
import { getProject } from './core/settings'
import { detectBuild, runBuild, stopBuild, gradleTasks } from './tools/build'
import { startTomcat, stopTomcat, checkRunConfig } from './tools/tomcat'
import { fastBuild } from './tools/deploy'

export async function buildProject(path: string, name: string): Promise<boolean> {
  const s = getProject(path, name)
  return runBuild(path, s.jdkHome, s.buildGoals, { offline: s.offline })
}

/** Run specific goals / tasks (Maven / Gradle tool window, "Execute goal") with the project JDK. */
export async function runGoals(path: string, name: string, goals: string): Promise<boolean> {
  const s = getProject(path, name)
  if (!goals.trim()) throw new Error('실행할 목표를 입력하세요')
  return runBuild(path, s.jdkHome, goals.trim(), { offline: s.offline })
}

/**
 * "의존성 업데이트" (IntelliJ: Reload / Download sources): re-resolve all dependencies and
 * plugins, forcing a check of the remote repositories for updated releases and snapshots.
 */
export async function updateDependencies(path: string, name: string): Promise<boolean> {
  const s = getProject(path, name)
  const info = await detectBuild(path)
  if (!info.tool) throw new Error('pom.xml 또는 build.gradle 을 찾을 수 없습니다')
  const goals = info.tool === 'maven' ? '-U dependency:resolve dependency:resolve-plugins' : '--refresh-dependencies dependencies'
  return runBuild(path, s.jdkHome, goals)
}

export async function listGradleTasks(path: string, name: string): Promise<string> {
  return gradleTasks(path, getProject(path, name).jdkHome)
}

export async function startRun(path: string, name: string, debug: boolean): Promise<void> {
  const s = getProject(path, name)
  await checkRunConfig(path, s.jdkHome, s.run, debug) // fail fast, before a long build
  if (s.run.buildBeforeRun) {
    const build = await detectBuild(path)
    if (build.tool) {
      const ok = s.run.fastBuild
        ? await fastBuild(path, s.jdkHome, s.run, s.offline, s.buildGoals)
        : await runBuild(path, s.jdkHome, s.buildGoals, { offline: s.offline })
      if (!ok) throw new Error('빌드 실패로 실행을 중단했습니다')
    }
  }
  await startTomcat(path, s.jdkHome, s.run, debug)
}

/** Stop the build and Tomcat of one project (each window has its own). */
export async function stopAll(path: string): Promise<void> {
  await stopBuild(path)
  await stopTomcat(path)
}
