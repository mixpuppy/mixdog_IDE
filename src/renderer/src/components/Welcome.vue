<script setup lang="ts">
import Icon from './Icon.vue'
import logo from '../assets/logo.svg'
import { store, openFolder, openRecent } from '../store'
import { openMenu } from '../ui'

const shortcuts: [string, string][] = [
  ['파일 저장', 'Ctrl + S'],
  ['탭 닫기', 'Ctrl + F4'],
  ['줄 복제 / 삭제', 'Ctrl + D / Ctrl + Y'],
  ['코드 정렬', 'Ctrl + Alt + L'],
  ['프로젝트 창', 'Alt + 1'],
  ['터미널', 'Alt + F12']
]
</script>

<template>
  <div class="welcome">
    <div class="inner">
      <img class="logo" :src="logo" alt="mixdog IDE" />
      <h1>mixdog IDE</h1>
      <p class="sub">{{ store.project ? '왼쪽 트리에서 파일을 선택하세요' : '프로젝트 폴더를 열어 시작하세요' }}</p>

      <button v-if="!store.project" class="primary-btn" @click="openFolder">
        <Icon name="open" :size="15" /> 폴더 열기
      </button>

      <div v-if="!store.project && store.recent.length" class="card">
        <div class="section-label">최근 프로젝트</div>
        <button
          v-for="r in store.recent"
          :key="r.path"
          class="recent"
          title="클릭: 열기 · 오른쪽 클릭: 새 창에서 열기"
          @click="openRecent(r)"
          @contextmenu="openMenu($event, [{ label: '이 창에서 열기', action: () => openRecent(r) }, { label: '새 창에서 열기', action: () => openRecent(r, true) }])"
        >
          <Icon name="folder" :size="15" class="folder" />
          <span class="rname">{{ r.name }}</span>
          <span class="rpath">{{ r.path }}</span>
        </button>
      </div>

      <div class="card keys">
        <div v-for="[label, key] in shortcuts" :key="label" class="key-row">
          <span>{{ label }}</span>
          <kbd>{{ key }}</kbd>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* the screen scrolls when the window is short; the content is centred with margin auto
   (align-items: center would cut off the top instead) */
.welcome {
  flex: 1;
  min-height: 0;
  display: flex;
  background: var(--surface);
  overflow: auto;
  container-type: size;
}
.inner {
  margin: auto;
  width: min(420px, calc(100% - 40px));
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding: 32px 0;
}
.logo {
  width: 96px;
  height: 96px;
  margin-bottom: -6px;
  filter: drop-shadow(0 10px 18px rgba(10, 132, 255, 0.3));
}
h1 {
  margin: 4px 0 0;
  font-size: 22px;
  font-weight: 700;
}
.sub {
  margin: 0 0 6px;
  color: var(--text-dim);
  text-align: center;
}
.card {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.card .section-label {
  padding: 2px 6px 6px;
}
.recent {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px;
  border-radius: 6px;
  text-align: left;
  min-width: 0;
}
.recent:hover {
  background: var(--hover);
}
.folder {
  color: #5ea8f2;
  flex-shrink: 0;
}
.rname {
  font-weight: 600;
  flex-shrink: 0;
}
.rpath {
  min-width: 0;
  color: var(--text-faint);
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.key-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 5px 6px;
  color: var(--text-dim);
}
kbd {
  font-family: var(--font-ui);
  font-size: 11.5px;
  color: var(--text);
  background: var(--elevated);
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: 5px;
  padding: 1px 7px;
  white-space: nowrap;
}

/* short editor area: smaller logo, shortcuts hidden (recent projects stay) */
@container (max-height: 620px) {
  .inner {
    gap: 10px;
    padding: 20px 0;
  }
  .logo {
    width: 56px;
    height: 56px;
    margin-bottom: -4px;
  }
  h1 {
    font-size: 19px;
  }
  .keys {
    display: none;
  }
}
@container (max-height: 330px) {
  .logo {
    display: none;
  }
}
/* narrow: shortcut rows wrap instead of overflowing */
@container (max-width: 360px) {
  .key-row {
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
  }
}
</style>
