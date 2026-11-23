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

### 컴파일 오류 (문제 창)

언어 서버(LSP) 없이, IDE 가 돌리는 빌드 출력에서 컴파일 오류·경고를 뽑습니다 (Maven javac·Kotlin, Gradle javac·Kotlin). 별도 프로세스가 없어 가볍습니다.

- 빌드·실행 전 빌드·**컴파일 검사**(문제 창의 망치 버튼 = Maven `compile` / Gradle `classes` 만 실행) 결과가 아래 **문제** 창에 파일별로 나오고, 클릭하면 그 줄로 이동합니다.
- 열린 편집기에 빨간 줄(오류)·노란 줄(경고)로 표시하고, 상태바에 오류 수를 표시합니다. 빌드가 컴파일 오류로 실패하면 문제 창이 열립니다.
- 컴파일 단계가 실제로 돈 빌드만 목록을 바꿉니다 (의존성 업데이트 같은 목표는 이전 결과 유지). 고친 뒤에는 다음 컴파일 때 사라집니다.
- Claude 도구: `check_compile`(컴파일만 하고 오류를 `경로:줄:칸: error: 메시지` 로 돌려줌), `get_problems`(마지막 결과). Claude 는 Java 를 고친 뒤 `check_compile` 로 확인하고 오류를 직접 고치도록 안내돼 있습니다. `build_project` 결과에도 오류 목록이 앞에 붙습니다.

### 디버거 (IntelliJ 디버그 창 방식)

**Shift+F9** (디버그 실행) 로 Tomcat 을 띄우면 IDE 가 Tomcat 의 디버그 포트(JDWP)에 직접 연결합니다. 언어 서버·추가 프로세스 없이 IDE 안의 작은 클라이언트(`src/main/debug/`)로 동작하고, 디버그할 때만 연결됩니다.

- **중단점**: `.java` 파일 줄 번호 왼쪽(회색 칸)을 클릭하거나 `Ctrl+F8`. 우클릭 → 조건 넣기 / 사용 안 함 / 삭제. 프로젝트별로 기억합니다.
  빨간 점 = 적용됨, 빈 빨간 원 = 아직 로드되지 않은 클래스(처음 실행될 때 적용), 테두리 점 = 조건 중단점, 회색 = 꺼짐. 빈 줄·주석 줄에 걸면 다음 코드 줄에서 멈춥니다.
- **조건**: `id == 5`, `name != null`, `user.id > 3`, `name.equals("홍길동")`, `flag` 처럼 변수(·필드) 와 값 비교. 해석할 수 없는 조건은 그냥 멈춥니다.
- **멈추면**: 아래 **디버그** 창이 열리고 그 줄이 파란색으로 표시됩니다. 왼쪽 = 호출 스택(스레드 선택, 클릭하면 그 위치로 이동, 라이브러리 프레임은 흐리게), 오른쪽 = 변수(`this`, 매개변수, 지역 변수).
  객체·배열을 펼치면 필드·요소가 나오고, String·숫자 래퍼·BigDecimal·Date·LocalDate(Time)·enum 은 값으로, ArrayList·HashMap·HashSet 은 `size = n` 과 요소로 보여 줍니다. 더블클릭 = 값 복사.
- **실행 제어**: F9 계속, F8 다음 줄, F7 들어가기(JDK·Spring·MyBatis 등 프레임워크 코드는 건너뜀), Shift+F8 나오기. 디버그 창 툴바의 중단점 목록 / 모두 끄기, 연결 끊기(Tomcat 은 계속 실행), IDE 밖에서 띄운 JVM 에 포트로 연결.

#### 디버거 - 아직 안 된 것 (나중에 할 일)

- [ ] 식 계산(Alt+F8) · 감시 식(Watches): 자바 식 해석 + 메서드 호출(InvokeMethod) 필요
- [ ] 변수 값 바꾸기 (SetValues)
- [ ] 코드 수정 후 재시작 없이 반영 (Hot Swap, RedefineClasses)
- [ ] JSP 안의 중단점 (JSP → 서블릿 줄 번호 매핑, SMAP)
- [ ] 예외 중단점 (특정 예외가 던져질 때 멈춤), 메서드 중단점
- [ ] 일시 정지(Pause) 버튼 · 커서까지 실행(Alt+F9) · 프레임 버리기(Drop Frame)
- [ ] 조건에 메서드 호출·`&&`/`||` 같은 복잡한 식, 로그만 남기고 멈추지 않는 중단점(Logpoint)
- [ ] `toString()` 결과로 객체 표시 (메서드 호출 필요), 람다·내부 클래스 변수 이름 정리
- [ ] Gradle / Spring Boot 단독 실행(Tomcat 이 아닌 main) 디버그 실행 구성

### 선언으로 이동 (Ctrl+B · Ctrl+클릭)

LSP 없이 텍스트 규칙으로 찾습니다 (Spring + MyBatis 기준, 백그라운드 프로세스 없음).

- Java: 클래스 이름 → 그 파일 (import → 같은 패키지 → `*` import → 프로젝트 안 같은 이름 순), `변수.메서드()` / `this.` / `Type.CONST` → 변수·필드·파라미터의 타입 클래스에서 메서드·필드 선언(없으면 상위 클래스·인터페이스), 지역 변수 → 선언 줄.
- MyBatis: 매퍼 인터페이스 메서드 → 인터페이스 선언 + XML 의 `<select|insert|update|delete id>` (둘 다 목록으로). XML 에서 `id="..."` → 인터페이스 메서드, `resultMap` / `refid` → `<resultMap>` / `<sql>` (다른 namespace 포함), `namespace` / `type` / `resultType` 등 `a.b.Class` → 클래스.
- JSP·properties 등: `a.b.Class` 형태의 이름 → 클래스.
- 컴파일러만큼 정확하지는 않습니다 (오버로드 구분 없음, 메서드 체인 `a().b()` 의 `b`, 라이브러리 클래스는 못 찾음).

IDE 가 관리하는 도구는 `%USERPROFILE%\.mixdog\{jdks,maven,tomcat}` 에 설치됩니다 (시스템 JAVA_HOME 은 그대로).

## 데이터베이스 (인텔리제이 Database 창 방식)

오른쪽 **데이터베이스** 도구 창에서 DB 에 연결하고 쿼리를 실행합니다. Oracle · MariaDB · MySQL · SQL Server · PostgreSQL.

- **+ 새 연결**: 종류·호스트·포트·DB(Oracle 은 서비스 이름 또는 SID)·사용자·비밀번호. 호스트 칸에 JDBC URL 을 붙여넣으면 나머지 칸이 채워집니다. [연결 테스트]로 저장 전에 확인.
- 비밀번호는 저장하거나(Windows 계정으로 암호화 - Electron safeStorage/DPAPI) 저장하지 않고 연결할 때마다 물어보게 할 수 있습니다.
- **읽기 전용** 연결은 조회 문(SELECT·WITH·SHOW·DESC·EXPLAIN)만 실행합니다. 운영 DB 에 권장.
- 트리: 연결 > 스키마 > 테이블·뷰(주석 표시) > 컬럼(타입·NOT NULL·PK·주석). 기본 스키마는 자동으로 펼침.
- **테이블 더블클릭** = 데이터 보기 (콘솔에 `SELECT * FROM 테이블` 을 넣고 실행).
- **쿼리 콘솔**: 연결마다 하나씩 있는 `.sql` 파일(`%APPDATA%\mixdog-ide\consoles`), 자동 저장. `Ctrl+Enter` = 커서가 있는 문장 실행(`;` 또는 빈 줄로 구분, Oracle PL/SQL 블록은 `/` 줄까지), 선택 후 `Ctrl+Enter` = 선택한 문장들 실행(결과 탭 여러 개).
  프로젝트의 다른 `.sql` 파일도 편집기 위 DB 선택에서 연결을 고르면 같은 방법으로 실행됩니다.
- 결과 표: 한 번에 최대 500행만 가져옵니다 (더 있으면 표시, 큰 테이블도 메모리 그대로). 보이는 행만 그려서 가볍고, 셀 선택·방향키·`Ctrl+C`, 우클릭 → 행/전체 복사(엑셀에 붙여넣기), 열 너비 조절.
- **자동완성** (`.sql` 편집기): 키워드, 현재 스키마의 테이블·뷰(주석), `FROM` 뒤엔 테이블·스키마, 문장에 쓴 테이블의 컬럼(타입·PK·주석), `별칭.` / `테이블.` 뒤엔 그 테이블 컬럼, `스키마.` 뒤엔 그 스키마 테이블. 메타데이터는 트리와 같은 캐시를 써서 DB 에 한 번만 물어봅니다 (비밀번호를 저장하지 않은 연결은 먼저 연결해야 컬럼이 나옴).
- **SQL 생성**: 테이블 우클릭 → SELECT(컬럼 목록 + PK 조건) / INSERT / UPDATE / DELETE 를 콘솔에 넣기(각 줄에 타입·주석 주석문), 컬럼 목록 복사. 컬럼을 `Ctrl/Shift+클릭` 으로 여러 개 고르고 우클릭 → 그 컬럼만으로 SELECT / INSERT / UPDATE.
- **결과 표 수정**: PK 가 결과에 있는 단일 테이블 SELECT 결과는 바로 고칠 수 있습니다 (헤더에 ✎ 테이블명 표시, JOIN·GROUP BY·서브쿼리·뷰·PK 없는 테이블·읽기 전용 연결은 불가 - 이유는 마우스를 올리면 표시).
  더블클릭·F2·바로 입력 = 값 수정(Enter 확정 · Tab 다음 칸 · Esc 취소), `Ctrl+Alt+N` NULL, `Alt+Insert` 행 추가(비워 둔 칸은 기본값), `Delete` 행 삭제 표시, `Ctrl+Z` 선택 영역 되돌리기, **`Ctrl+S` 저장**.
  저장은 PK 기준 UPDATE / DELETE / INSERT 를 한 트랜잭션으로 실행하고(한 행이라도 PK 로 못 찾거나 여러 행이 바뀌면 전부 취소), 끝나면 다시 조회합니다. [SQL 미리보기]로 실행될 문장을 볼 수 있습니다.
- 결과 표 선택: 드래그·Shift+클릭으로 범위, 행 번호 클릭으로 행 전체, `Ctrl+A` 전체. 우클릭 → 선택한 행을 **INSERT 문 / UPDATE 문으로 복사**.
- **자동 커밋 / 수동 커밋** (편집기 위 막대): 기본은 자동 커밋. 수동 커밋이면 실행·저장한 변경이 [커밋]을 누르기 전까지 확정되지 않고(`● 커밋 대기` 표시), [롤백]으로 취소합니다. 콘솔에 `COMMIT` / `ROLLBACK` 을 쳐도 같습니다.
  커밋하지 않은 변경이 있으면 연결 끊기·창 닫기 전에 커밋/롤백을 묻습니다 (MySQL·Oracle 은 DDL 이 자동 커밋함, PostgreSQL 은 오류 후 롤백해야 계속 가능).
- 실행 중 [중지] = 연결을 닫아 쿼리를 멈춤 (다음 쿼리 때 다시 연결, 커밋 안 한 변경은 롤백됨).
- 드라이버는 순수 JS(mysql2, pg, mssql, oracledb)라 따로 설치할 것이 없고, 처음 연결할 때만 불러옵니다.
- **Oracle 11g**: 기본(Thin) 방식은 12.1 이상만 됩니다. 11g 서버는 **Oracle Instant Client 19c (64bit)** 를 받아 연결 설정의 Oracle Client 폴더로 지정하고 IDE 를 다시 시작하세요 (19 미만 클라이언트, 예: Oracle XE 11g 에 들어 있는 것은 못 씀).
- Claude 에는 `db_list_connections`, `db_describe`, `db_query`(조회만, 기본 100행) 도구로 열립니다. 변경 문은 거부되므로 Claude 는 SQL 을 파일로 써 주고 사용자가 실행합니다. 비밀번호를 저장하지 않은 연결은 사용자가 먼저 연결해야 씁니다.

## AI (Claude Code) 연동

- 오른쪽 **Claude** 패널(`Ctrl+Shift+A`)에서 **내 구독으로 로그인된 Claude Code CLI 를 그대로 실행**합니다. IDE 는 Claude 인증 정보에 손대지 않습니다.
- 권한 모드는 Claude Code 그대로: 패널 안에서 `Shift+Tab` 으로 수동 승인 / 편집 자동 수락 / 계획 / 권한 무시를 실시간 전환.
- IDE 는 로컬 MCP 서버(`mixdog`, 127.0.0.1 + 무작위 토큰)를 열어 Claude 에 IDE 도구를 줍니다:
  `get_ide_state`, `get_recent_events`, `get_editor_text`(저장 안 한 내용 포함), `open_file`, `get_console`, `build_project`, `check_compile`, `get_problems`, `run_tomcat`, `stop_tomcat`, `list_ide_commands`, `run_ide_command`, DB 조회 `db_list_connections`·`db_describe`·`db_query`
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
| 디버그: 중단점 / 계속 / 다음 줄 / 들어가기 / 나오기 | Ctrl+F8 (또는 줄 번호 왼쪽 클릭) / F9 / F8 / F7 / Shift+F8 |
| 선언으로 이동 | Ctrl+B / Ctrl+클릭 / F12 (Ctrl 누른 채 마우스를 올리면 미리보기, 여러 곳이면 목록) |
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
| `src/main/tools/problems.ts` · `renderer/src/problems.ts` | 빌드 출력에서 컴파일 오류·경고 추출 / 편집기 빨간 줄(Monaco 마커) |
| `src/main/debug/jdwp.ts` · `session.ts` · `renderer/src/debug.ts` · `components/tools/DebugTool.vue` | 디버거: JDWP 프로토콜 클라이언트 / 중단점·단계 실행·스택·변수 / 편집기 중단점 표시·실행 줄 / 디버그 창 |
| `src/main/tools/navigate.ts` · `renderer/src/navigation.ts` | 선언으로 이동 (텍스트 규칙: Java·MyBatis XML) / Monaco Ctrl+클릭·Ctrl+B 연결 |
| `src/main/tools/deploy.ts` | 실행 전 빠른 빌드 (증분 컴파일 + 바뀐 파일만 exploded 폴더에 복사) |
| `src/main/tools/tomcat.ts` | Tomcat 탐지 · 다운로드 · 프로젝트별 CATALINA_BASE · 실행/디버그 · JSP 저장 시 반영 |
| `src/main/tools/db.ts` | DB 연결 (드라이버 지연 로딩, 비밀번호 암호화 저장, 행 제한 조회, 스키마·테이블·컬럼 조회, 읽기 전용 판정) |
| `src/renderer/src/db.ts` + `components/db/` | 데이터베이스 도구 창, 연결 대화상자, SQL 편집기 막대·문장 나누기(Ctrl+Enter)·커밋 모드, 결과 표(수정·저장) |
| `src/renderer/src/dbsql.ts` · `dbcomplete.ts` | SQL 에서 테이블 찾기·이름 따옴표·값 리터럴·SQL 생성 / SQL 자동완성 |
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
- [x] 데이터베이스 1차: Oracle·MariaDB·MySQL·SQL Server·PostgreSQL 연결, 스키마 트리, 쿼리 콘솔(Ctrl+Enter), 결과 표, 읽기 전용 연결, Claude 조회 도구
- [x] 데이터베이스 2차: SQL 자동완성(테이블·컬럼·별칭), SQL 생성, 결과 표에서 바로 수정·저장, 자동/수동 커밋
- [ ] 데이터베이스 3차: 내보내기(CSV·엑셀), 실행 계획, SSH 터널, 테이블 DDL 보기
- [x] 컴파일 오류: 빌드 출력 → 문제 창·편집기 빨간 줄·상태바, Claude `check_compile` / `get_problems`
- [x] 선언으로 이동: Ctrl+B·Ctrl+클릭 (텍스트 규칙, Java·MyBatis XML)
- [x] 디버거 1차: Tomcat 디버그 포트 직접 연결(JDWP), 줄 중단점·조건, 스택·변수, F7/F8/Shift+F8/F9 (남은 일은 위 "디버거 - 아직 안 된 것")
- [ ] (보류) LSP: Claude 가 코드를 고치는 방식이라 무게 대비 이득이 적어 보류
