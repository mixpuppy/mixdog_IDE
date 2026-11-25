/**
 * Git error output → a plain explanation for the error window: what happened, which files,
 * what to do, and buttons that do it (stash + retry, pull first, open the changes...).
 */
import type { ErrorAction, ErrorInfo } from './ui'

/** Git Credential Manager's "TLS verification disabled" banner: printed on every remote call, never the cause */
const TLS_NOISE = /^warning: (?:-{5,}.*|\|.*TLS certificate verification.*|\|?\s*-{5,}.*|HTTPS connections may not be secure.*)$/i

export function cleanGitOutput(raw: string): { text: string; tlsWarning: boolean } {
  const msg = raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
  // the main process joins output lines with spaces in some paths: split the known markers back to lines
  const split = msg.replace(/\s+(?=(warning|error|fatal|hint|CONFLICT|Aborting|Updating|Please|Auto-merging|Automatic|To |! \[)\b)/g, '\n')
  let tls = false
  const lines = split.split(/\r?\n/).filter((l) => {
    if (TLS_NOISE.test(l.trim())) {
      tls = true
      return false
    }
    return true
  })
  return { text: lines.join('\n').trim(), tlsWarning: tls }
}

/** file names listed by git under "...following files..." (indented lines, or space separated on one line) */
function filesAfter(text: string, marker: RegExp): string[] {
  const m = text.match(marker)
  if (!m) return []
  const rest = text.slice((m.index ?? 0) + m[0].length)
  const end = rest.search(/\n?(Please|Aborting|error:|fatal:|hint:)/)
  const block = (end >= 0 ? rest.slice(0, end) : rest).trim()
  return block
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith(':'))
}

export interface GitErrorFixes {
  /** stash local changes, run the operation again, then restore the changes */
  stashAndRetry?: () => unknown
  pull?: () => unknown
  showChanges?: () => unknown
  retry?: () => unknown
}

export function explainGitError(op: string, raw: string, fix: GitErrorFixes = {}): ErrorInfo {
  const { text, tlsWarning } = cleanGitOutput(raw)
  const note = tlsWarning
    ? '참고: "TLS certificate verification has been disabled" 경고는 Git 자격 증명 관리자 설정(인증서 검사 끔) 때문에 매번 나오는 안내이고, 이번 오류의 원인은 아닙니다.'
    : undefined
  const base = { title: `Git ${op} 실패`, raw: text, note }
  const act = (label: string, run: (() => unknown) | undefined, primary = false): ErrorAction[] => (run ? [{ label, run, primary }] : [])

  // local edits in the way of pull / merge / checkout
  if (/Your local changes to the following files would be overwritten by (merge|checkout)/i.test(text)) {
    const by = /overwritten by checkout/i.test(text) ? 'checkout' : 'merge'
    return {
      ...base,
      summary:
        by === 'merge'
          ? `커밋하지 않은 내 수정 파일이 ${op === 'Pull' ? '받아올' : '병합할'} 변경과 겹쳐서 Git 이 ${op} 을(를) 멈췄습니다. 아무것도 바뀌지 않았습니다.`
          : '커밋하지 않은 내 수정 파일이 전환할 브랜치의 내용과 겹쳐서 Git 이 전환을 멈췄습니다. 아무것도 바뀌지 않았습니다.',
      items: filesAfter(text, /would be overwritten by (?:merge|checkout):/i),
      hint:
        '해결 방법 (하나 고르세요)\n' +
        '• 스태시하고 다시 실행: 내 수정을 잠시 보관 → ' + op + ' → 보관한 수정을 다시 적용합니다. 같은 줄을 서로 고쳤다면 그때 충돌로 표시됩니다.\n' +
        '• 먼저 커밋: 내 수정을 커밋한 뒤 다시 ' + op + ' 하면 병합으로 합쳐집니다.\n' +
        '• 필요 없는 수정이면 변경 화면에서 버린 뒤 다시 실행합니다.',
      actions: [...act('변경 사항 보기', fix.showChanges), ...act(`스태시하고 다시 ${op}`, fix.stashAndRetry, true)]
    }
  }
  // new (untracked) files in the way
  if (/untracked working tree files would be (overwritten|removed)/i.test(text)) {
    return {
      ...base,
      summary: `Git 에 올리지 않은 새 파일이 ${op} 로 들어올 파일과 이름이 같아서 멈췄습니다. 아무것도 바뀌지 않았습니다.`,
      items: filesAfter(text, /would be (?:overwritten|removed) by \w+:/i),
      hint: '이 파일들을 다른 곳으로 옮기거나 지운 뒤 다시 실행하세요. (스태시에 새 파일 포함으로 보관해도 됩니다)',
      actions: [...act('변경 사항 보기', fix.showChanges), ...act(`스태시하고 다시 ${op}`, fix.stashAndRetry, true)]
    }
  }
  // stash pop after "스태시하고 다시": the operation worked, putting my edits back collided
  if (/^Stash (pop|apply)$/i.test(op) && /CONFLICT|충돌/i.test(text)) {
    return {
      ...base,
      title: '내 수정을 다시 적용하다가 충돌',
      summary:
        '받아오기(또는 전환)는 끝났고, 보관해 둔 내 수정을 다시 적용하다가 같은 부분(또는 바로 붙은 줄)을 양쪽에서 고쳐서 충돌이 났습니다.',
      hint:
        '충돌 파일의 <<<<<<< ======= >>>>>>> 표시 부분을 정리하고 스테이지하세요.\n' +
        '보관본(stash@{0})은 지워지지 않고 남아 있어 수정이 사라지지 않습니다. 정리가 끝나면 Git 화면의 스태시 목록에서 지우면 됩니다.',
      actions: act('충돌 파일 보기', fix.showChanges, true)
    }
  }
  // merge conflicts
  if (/CONFLICT|Automatic merge failed|could not apply|충돌/i.test(text)) {
    const files = [...text.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(.+)/g)].map((m) => m[1].trim())
    return {
      ...base,
      title: `Git ${op}: 충돌`,
      summary: '같은 부분을 양쪽에서 고쳐서 자동으로 합치지 못했습니다. 충돌 파일을 정리한 뒤 스테이지하고 커밋하면 마무리됩니다.',
      items: files,
      hint: 'Git 화면 위쪽 안내 줄에서 진행 상황을 볼 수 있고, [취소 (abort)] 로 이전 상태로 되돌릴 수도 있습니다.',
      actions: act('변경 사항 보기', fix.showChanges, true)
    }
  }
  // push rejected: remote has commits I don't have
  if (/\[rejected\]|failed to push|non-fast-forward|fetch first/i.test(text)) {
    return {
      ...base,
      summary: '원격 브랜치에 내 쪽에 없는 커밋이 있어서 푸시가 거절됐습니다.',
      hint: '먼저 Pull 로 원격 커밋을 받아 합친 뒤 다시 Push 하세요.',
      actions: act('Pull 하기', fix.pull, true)
    }
  }
  // diverged branches and pull has no strategy
  if (/divergent branches|Not possible to fast-forward/i.test(text)) {
    return {
      ...base,
      summary: '내 브랜치와 원격 브랜치가 서로 다른 커밋을 갖고 있어서, 어떻게 합칠지(병합/리베이스) 정해져 있지 않아 멈췄습니다.',
      hint: '터미널에서 한 번만 설정하면 됩니다:\ngit config pull.rebase false   (병합으로 합치기, 권장)'
    }
  }
  if (/no tracking information|has no upstream branch/i.test(text)) {
    return {
      ...base,
      summary: '이 브랜치는 연결된 원격 브랜치(업스트림)가 없습니다.',
      hint: '처음 푸시할 때 원격 브랜치가 만들어지고 연결됩니다. 브랜치 팝업에서 원격 브랜치를 골라 비교하거나 Push 하세요.'
    }
  }
  if (/Authentication failed|could not read Username|terminal prompts disabled|403|401/i.test(text)) {
    return {
      ...base,
      summary: '원격 저장소 인증에 실패했습니다 (아이디/비밀번호 또는 토큰).',
      hint: 'Windows 자격 증명 관리자에서 해당 Git 서버 항목을 지우고 다시 시도하면 로그인 창이 다시 뜹니다. 토큰이 만료됐을 수도 있습니다.',
      actions: act('다시 시도', fix.retry, true)
    }
  }
  if (/Could not resolve host|unable to access|Failed to connect|timed out|Connection refused|SSL/i.test(text)) {
    return {
      ...base,
      summary: '원격 저장소에 연결하지 못했습니다 (네트워크·VPN·프록시 문제일 수 있습니다).',
      hint: '사내망/VPN 연결을 확인한 뒤 다시 시도하세요.',
      actions: act('다시 시도', fix.retry, true)
    }
  }
  if (/index\.lock|Another git process/i.test(text)) {
    return {
      ...base,
      summary: '다른 Git 작업이 아직 진행 중이거나, 예전에 비정상 종료된 Git 이 잠금 파일(index.lock)을 남겼습니다.',
      hint: '다른 Git 프로그램(소스트리 등)이 작업 중이 아닌지 확인하세요. 아무것도 돌고 있지 않으면 .git\\index.lock 파일을 지우고 다시 시도하면 됩니다.',
      actions: act('다시 시도', fix.retry, true)
    }
  }
  // unknown: first error / fatal line as the summary
  const first = text.split('\n').find((l) => /^(error|fatal):/i.test(l)) ?? text.split('\n')[0] ?? ''
  return { ...base, summary: first.replace(/^(error|fatal):\s*/i, '') || `${op} 중 오류가 발생했습니다.`, actions: act('다시 시도', fix.retry) }
}
