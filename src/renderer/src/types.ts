export interface JdkInfo {
  home: string
  major: number
  version: string
  vendor: string
  managed: boolean
}

export interface TomcatInfo {
  home: string
  version: string
  major: number
  managed: boolean
}

export interface BuildInfo {
  tool: 'maven' | 'gradle' | null
  exe: string | null
  via: 'wrapper' | 'managed' | 'path' | 'missing' | 'none'
  defaultGoals: string
}

export interface RunConfig {
  tomcatHome: string | null
  contextPath: string
  httpPort: number
  debugPort: number
  buildBeforeRun: boolean
  fastBuild: boolean
  deployPath: string | null
  vmOptions: string
}

export interface ProjectSettings {
  jdkHome: string | null
  buildGoals: string | null
  offline: boolean
  run: RunConfig
}

export interface ProjectInfo {
  settings: ProjectSettings
  build: BuildInfo
  detectedJava: number | null
  jdk: JdkInfo | null
  tomcat: TomcatInfo | null
}

export interface IdeEvent {
  id: number
  time: number
  type: string
  source: string
  data: Record<string, unknown>
}
