# mixdog IDE

개인용 IDE. Windows에서 동작하는 macOS 스타일 UI, IntelliJ 키맵 기반.

## 실행

```powershell
npm.cmd install
npm.cmd run dev          # 개발 모드 (렌더러 핫 리로드)
npm.cmd run build        # 빌드 (out/)
```

- PowerShell 에서 `npm` 이 "스크립트를 실행할 수 없으므로" 오류로 막히면 `npm.cmd` 로 실행하세요 (실행 정책 때문에 `npm.ps1` 이 막힌 것).
- **개발판과 설치판은 동시에 실행됩니다.** 개발판(`npm.cmd run dev`)은 `%APPDATA%\mixdog-ide-dev`, 설치판(EXE)은 `%APPDATA%\mixdog-ide` 를 따로 씁니다. 그래서 개발하는 동안에도 설치판을 그대로 쓸 수 있습니다. JDK·Tomcat·실행 구성 같은 설정(`%APPDATA%\mixdog-ide\settings.json`)은 둘이 함께 씁니다.

### 패치 (포터블로 쓰는 경우)

```powershell
npm.cmd run patch        # EXE 를 새로 만들고 설치 폴더의 EXE 를 새 버전으로 교체
npm.cmd run patch:copy   # 이미 만든 EXE 만 다시 설치 (IDE 가 켜져 있어 교체에 실패했을 때)
```

- 실제 파일: `%LOCALAPPDATA%\Programs\mixdog-IDE-portable\mixdog IDE.exe`, 실행은 **바탕화면의 `mixdog IDE` 바로가기**로 합니다.
  (EXE 자체를 바탕화면에 두면 Windows 가 예전 아이콘을 계속 보여 줘서 바로가기를 씁니다.)
- `dist` 폴더의 파일을 직접 실행하면 다음 빌드 때 파일이 잠겨 실패합니다.
- 교체할 때 IDE 가 켜져 있으면 실패하므로, 창을 모두 닫고 `patch:copy` 를 실행하세요.

### EXE 만들기

```powershell
npm run dist        # dist\mixdog-IDE-Setup-<버전>.exe (설치형) + dist\mixdog-IDE-<버전>-portable.exe (설치 없이 실행)
npm run dist:dir    # 설치 파일 없이 dist\win-unpacked\ 폴더만 (빠른 확인용)
```

- 처음 빌드에서 `winCodeSign ... Cannot create symbolic link` 오류가 나면: 개발자 모드가 꺼진 Windows 에서 macOS 용 파일 2개 압축 해제가 실패하는 알려진 문제입니다. 아래처럼 한 번만 직접 풀어 두면 됩니다 (Windows 용 파일은 정상 해제, 종료 코드 2 는 무시).
  `node_modules\7zip-bin\win\x64\7za.exe x -y %LOCALAPPDATA%\electron-builder\Cache\winCodeSign\<받은파일>.7z -o%LOCALAPPDATA%\electron-builder\Cache\winCodeSign\winCodeSign-2.6.0`
- 코드 서명을 하지 않았기 때문에 처음 실행 시 Windows SmartScreen 경고가 뜰 수 있습니다 ([추가 정보] → [실행]).
- EXE 를 다시 실행하면 기존 창이 앞으로 옵니다. 폴더를 인자로 주면 그 폴더를 **새 창**으로 엽니다 (이미 열린 프로젝트면 그 창이 앞으로): `"mixdog IDE.exe" D:\work\myproj`

### 여러 창 (멀티태스킹)

- 타이틀바 왼쪽 프로젝트 버튼: 폴더 열기 / **새 창에서 폴더 열기** / 새 창(빈 창) / 최근 프로젝트.
- 프로젝트가 열린 창에서 다른 프로젝트를 열면 인텔리제이처럼 "이 창 / 새 창" 을 묻습니다. 시작 화면의 최근 프로젝트는 오른쪽 클릭 → 새 창에서 열기.
- 창마다 따로: 이벤트 로그, 터미널, Claude 세션(각 창의 Claude 는 그 창의 프로젝트만 봄), 빌드, Tomcat(포트는 각 프로젝트 실행 구성), 파일·Git 변경 감시.

특정 폴더를 바로 열기 (개발 모드): `$env:MIXDOG_PROJECT='D:\work\myproj'; npm run dev`

### 실행 전 빌드 (빠른 빌드 · 오프라인)

실행 구성(Tomcat 설정)의 **빌드 방식**:

- **빠른 빌드** (기본, 인텔리제이 방식): `clean` 과 war 압축 없이 `mvn compile`(Gradle: `classes`) 만 돌리고, 바뀐 클래스·웹 파일만 exploded 배포 폴더에 복사합니다 (지워진 클래스는 배포 폴더에서도 지움).
  배포 폴더(`target/<finalName>`, WEB-INF/lib 포함)는 처음 한 번, 그리고 `pom.xml` 이 바뀌었을 때만 `war:exploded` 로 새로 만듭니다 (`WEB-INF/.mixdog-deploy` 에 pom 해시 기록).
  여러 모듈 Maven 프로젝트, war 가 아닌 프로젝트, exploded 폴더가 없는 Gradle 프로젝트는 전체 빌드로 넘어갑니다.
- **전체 빌드**: 프로젝트 설정의 빌드 목표(기본 `clean package -DskipTests`)를 그대로 실행.
- **오프라인** (실행 구성 또는 Maven 창의 [오프라인]): 모든 빌드에 `-o` / `--offline` 을 붙여 원격 저장소 확인을 건너뜁니다. 로컬에 없는 의존성 때문에 실패하면 자동으로 한 번 온라인으로 다시 빌드합니다. [의존성 업데이트]는 항상 온라인.

IDE 가 관리하는 도구는 `%USERPROFILE%\.mixdog\{jdks,maven,tomcat}` 에 설치됩니다 (시스템 JAVA_HOME 은 그대로).

## AI (Claude Code) 연동

- 오른쪽 **Claude** 패널(`Ctrl+Shift+A`)에서 **내 구독으로 로그인된 Claude Code CLI 를 그대로 실행**합니다. IDE 는 Claude 인증 정보에 손대지 않습니다.
- 권한 모드는 Claude Code 그대로: 패널 안에서 `Shift+Tab` 으로 수동 승인 / 편집 자동 수락 / 계획 / 권한 무시를 실시간 전환.
- IDE 는 로컬 MCP 서버(`mixdog`, 127.0.0.1 + 무작위 토큰)를 열어 Claude 에 IDE 도구를 줍니다:
  `get_ide_state`, `get_recent_events`, `get_editor_text`(저장 안 한 내용 포함), `open_file`, `get_console`, `build_project`, `run_tomcat`, `stop_tomcat`, `list_ide_commands`, `run_ide_command`
- Claude 가 파일을 고치면 열린 탭이 자동으로 새로 고쳐지고(`file.changed` 이벤트), Claude 의 IDE 도구 호출은 이벤트 로그에 `ai:claude` 로 남습니다.
- **세션**: 패널 위쪽 탭으로 여러 대화를 동시에 실행. [세션 목록]에서 이 프로젝트의 지난 대화(Claude 앱에서 한 대화 포함)를 보고 [열기]로 이어 하거나 [분기]로 복사본에서 새로 시작. 탭 이름 더블클릭 = 이름 바꾸기(`/rename`, Claude 앱에도 반영). 탭을 닫아도 대화는 남음.
- 에디터에서 `Ctrl+Alt+K` (또는 우클릭 → Claude 에게 보내기): 현재 파일·선택 줄을 `@경로#L10-20` 으로 Claude 입력창에 넣기.
- 주의: MCP 서버 이름을 `ide` 로 하면 Claude Code 가 자체 IDE 연동용 이름이라 도구를 숨깁니다 → `mixdog` 사용.
- 정책: 구독 로그인은 Claude Code 를 직접 쓰는 경우에만 허용됩니다. Agent SDK 로 IDE 가 직접 모델을 호출하는 방식은 API 키가 필요합니다 (나중에 API 키 모드를 추가할 경우).

## 단축키 (IntelliJ Windows 키맵)

| 동작 | 키 |
|---|---|
| 빌드 | Ctrl+F9 |
| 실행 / 디버그 / 중지 | Shift+F10 / Shift+F9 / Ctrl+F2 |
| 프로젝트 설정 (JDK·빌드) | Ctrl+Alt+Shift+S |
| 저장 / 탭 닫기 | Ctrl+S / Ctrl+F4 |
| 줄 복제 / 삭제 / 정렬 | Ctrl+D / Ctrl+Y / Ctrl+Alt+L |
| 프로젝트 창 / 터미널 | Alt+1 / Alt+F12 |
| Git 화면 / 커밋 | Alt+9 / Ctrl+Enter (커밋 메시지 칸) |
| 어디서나 찾기 (파일·클래스·텍스트·동작) | Shift 두 번 (Tab 으로 탭 전환, 텍스트 탭은 코드 내용 + 미리보기, Ctrl+Enter 로 검색 창에 보내기) |
| 파일 찾기 / 클래스 찾기 / 최근 파일 | Ctrl+Shift+N / Ctrl+N / Ctrl+E (`이름:줄번호` 로 바로 이동, 대문자 약어 `uSI` → UserServiceImpl) |
| 프로젝트에서 찾기 / 바꾸기 | Ctrl+Shift+F / Ctrl+Shift+R (정규식·대소문자·단어 단위·파일 마스크) |
| 파일 안에서 찾기 / 바꾸기 | Ctrl+F / Ctrl+R |
| Git 브랜치 팝업 (인텔리제이식) | Ctrl+Shift+` 또는 타이틀바 브랜치 클릭 |
| Claude 패널 / Claude 에게 보내기 | Ctrl+Shift+A / Ctrl+Alt+K |

## 구조

| 경로 | 역할 |
|---|---|
| `src/main/index.ts` | Electron 메인 프로세스: 창(Mica, 숨김 타이틀바), 파일 IO |
| `src/main/core/events.ts` | **이벤트 버스** - IDE 의 모든 동작 기록 (AI 연동의 입구) |
| `src/main/core/commands.ts` | 메인/AI → 렌더러 명령 호출 브리지 |
| `src/main/core/settings.ts` | 설정 저장 (`%APPDATA%\mixdog-ide\settings.json`, 프로젝트별 JDK·실행 구성) |
| `src/main/tools/jdk.ts` | JDK 탐지 · Temurin 다운로드 · pom/gradle 의 Java 버전 감지 |
| `src/main/tools/build.ts` | Maven / Gradle 탐지 (래퍼 → IDE 관리 → PATH) 와 빌드 실행 |
| `src/main/tools/deploy.ts` | 실행 전 빠른 빌드 (증분 컴파일 + 바뀐 파일만 exploded 폴더에 복사) |
| `src/main/tools/tomcat.ts` | Tomcat 탐지 · 다운로드 · 프로젝트별 CATALINA_BASE · 실행/디버그 · JSP 저장 시 반영 |
| `src/main/tools/git.ts` | Git (사용자의 git.exe·인증 그대로) - 상태·로그·브랜치·커밋·원격, `.git` 변경 감시 |
| `src/renderer/src/git.ts` + `components/git/` | Git 화면: 커밋 그래프 배치, 변경 파일·커밋 박스, 커밋 상세, diff, 브랜치 목록 |
| `src/main/ipc.ts` | 렌더러용 IPC 핸들러 |
| `src/renderer/src/commands.ts` | **명령 레지스트리** - 버튼·단축키·AI 가 같은 명령을 호출 |
| `src/renderer/src/ide.ts` | 프로젝트 상태 · 빌드/Tomcat 콘솔 · 이벤트 로그 |
| `src/main/ai/mcp-server.ts` | Claude 용 IDE 도구 MCP 서버 (Streamable HTTP, 로컬 전용) |
| `src/main/ai/claude.ts` | Claude Code CLI 찾기 · 실행 인자 · MCP 설정 파일 |
| `src/main/core/pty.ts` | 터미널(ConPTY) - PowerShell 패널, Claude Code |
| `src/main/core/watcher.ts` | 프로젝트 파일 변경 감시 → 열린 탭 자동 새로고침 |
| `src/main/actions.ts` | 빌드/실행/중지 - UI 와 AI 가 같은 코드 사용 |
| `src/preload/index.ts` | 렌더러에 노출하는 `window.api` |
| `src/renderer/src/store.ts` | 전역 상태 (프로젝트, 탭, 패널) |
| `src/renderer/src/monaco.ts` | Monaco 설정, 테마, 확장자→언어 매핑 |
| `src/renderer/src/styles/global.css` | 색상·폰트 토큰 (라이트/다크) |
| `src/renderer/src/layout.ts` + `components/tools/` | 도구 창 배치(도크·드래그 앤 드롭·위치 저장), 도구 창 내용은 한 번만 만들고 Teleport 로 옮김 |
| `src/renderer/src/components/EditorArea.vue`, `SplitNode.vue`, `EditorPane.vue` | 코드 창 분할 (분할 트리, 탭 드래그 드롭) |
| `src/renderer/src/components/` | TitleBar, ActivityBar, Sidebar, TreeNode, EditorTabs, CodeEditor, BottomPanel, StatusBar, Welcome |

## 로드맵

- [x] 1단계: macOS 스타일 창 / 파일 트리 / 탭 / Monaco 에디터 / 저장
- [x] 2단계: JDK 관리(탐지·다운로드·프로젝트별 선택), Maven/Gradle 빌드, Tomcat 실행 구성(8.5~11, exploded 배포, 실행·디버그 포트, JSP 저장 즉시 반영), 이벤트 버스·명령 레지스트리
- [x] AI 연동 1차: Claude Code(구독) 내장 + IDE MCP 도구 + 파일 자동 새로고침 + 내장 PowerShell 터미널
- [ ] AI 연동 2차: Codex / Gemini CLI 도 같은 방식으로 추가, Claude 도구 사용 기록(hooks)을 이벤트 로그에 연결
- [x] 4단계: Git 1차 (GitKraken 스타일 그래프 + 소스트리식 "모든 브랜치 / 현재 브랜치" 보기와 업스트림·다른 브랜치 비교(↑푸시할·↓받을 커밋), 스테이징·커밋·amend, 브랜치·체크아웃·병합·삭제, Pull/Push/Fetch, 스태시, reset·revert·체리픽, 충돌 상태·abort, diff 뷰어(변경 부분만·전체 비교, 앞뒤 줄 수·공백 무시, 코드뭉치 단위 스테이지·내리기·버리기), 인텔리제이식 브랜치 팝업(검색·최근·로컬·원격, 브랜치별 체크아웃·비교·병합·이름 변경·삭제), GitLab MR 작성 화면 열기)
- [ ] Git 2차: 줄 하나씩 골라 스테이징, 충돌 3-way 해결 화면, 파일 히스토리·blame, 태그 만들기
- [x] 작업 목록 + 강아지 프로그레스바 (상태바: 빌드·Tomcat 시작·Git 원격 작업·다운로드, Claude 가 시작한 작업 표시, 취소 버튼)
- [x] 창 배치: 도구 창(프로젝트·Git·서버·빌드·Tomcat·이벤트·터미널·문제)을 왼쪽/오른쪽/아래로 드래그해 옮기기(위치 기억, 터미널은 옮겨도 그대로), 코드 창 분할(오른쪽·아래, 중첩 분할, 탭 드래그로 분할·이동), Git 변경/스테이지/커밋 칸 크기 조절
- [x] 5단계: 검색 - 어디서나 찾기(Shift 두 번), 파일·클래스·최근 파일 찾기, 프로젝트에서 찾기·바꾸기 (git ls-files 기반 파일 목록, .gitignore 존중)
- [x] Maven / Gradle 도구 창 (오른쪽): 라이프사이클·플러그인 목표·프로필·의존성·모듈(Maven), 작업 그룹(Gradle), 더블클릭 실행, 목표 직접 실행(기록), 오프라인·테스트 건너뛰기, 의존성 업데이트(-U / --refresh-dependencies)
- [ ] 6단계: LSP (Java: jdtls, Vue: vue-language-server, JSP)
