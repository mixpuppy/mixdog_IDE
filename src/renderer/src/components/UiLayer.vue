<script setup lang="ts">
/** Global context menu + prompt/confirm sheet (see ui.ts). */
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'
import Sheet from './Sheet.vue'
import { ui, closeMenu, type MenuItem } from '../ui'

const menuEl = ref<HTMLElement | null>(null)
const pos = ref({ x: 0, y: 0 })
const input = ref<HTMLInputElement | null>(null)
const text = ref('')
const checked = ref(false)

watch(
  () => ui.menu,
  async (m) => {
    if (!m) return
    pos.value = { x: m.x, y: m.y }
    await nextTick()
    const r = menuEl.value?.getBoundingClientRect()
    if (!r) return
    // keep the menu on screen
    pos.value = {
      x: Math.min(m.x, window.innerWidth - r.width - 6),
      y: m.y + r.height > window.innerHeight - 6 ? Math.max(6, m.y - r.height) : m.y
    }
  }
)

watch(
  () => ui.ask,
  async (a) => {
    if (!a) return
    text.value = a.value ?? ''
    checked.value = a.check?.value ?? false
    await nextTick()
    input.value?.focus()
    input.value?.select()
  }
)

function pick(i: MenuItem): void {
  if (i.disabled || i.header) return
  closeMenu()
  i.action?.()
}

function choose(i: number | null): void {
  const c = ui.choice
  if (!c) return
  ui.choice = null
  c.resolve(i)
}

function answer(ok: boolean): void {
  const a = ui.ask
  if (!a) return
  ui.ask = null
  a.resolve(ok ? { value: text.value.trim(), checked: checked.value } : null)
}

const away = (e: MouseEvent): void => {
  if (ui.menu && !menuEl.value?.contains(e.target as Node)) closeMenu()
}
const esc = (e: KeyboardEvent): void => {
  if (e.key === 'Escape' && ui.menu) closeMenu()
}
onMounted(() => {
  window.addEventListener('mousedown', away, true)
  window.addEventListener('keydown', esc)
  window.addEventListener('blur', closeMenu)
})
onBeforeUnmount(() => {
  window.removeEventListener('mousedown', away, true)
  window.removeEventListener('keydown', esc)
  window.removeEventListener('blur', closeMenu)
})
</script>

<template>
  <div v-if="ui.menu" ref="menuEl" class="ctx" :style="{ left: pos.x + 'px', top: pos.y + 'px' }" @contextmenu.prevent>
    <template v-for="(i, n) in ui.menu.items" :key="n">
      <div v-if="i.sep" class="sep" />
      <div v-if="i.header" class="mhead">{{ i.label }}</div>
      <div v-else class="item" :class="{ danger: i.danger, disabled: i.disabled }" @click="pick(i)">
        <span v-if="ui.menu.items.some((m) => m.checked !== undefined)" class="chk-col">{{ i.checked ? '✓' : '' }}</span>{{ i.label }}<span v-if="i.hint" class="hint" :title="i.hint">{{ i.hint }}</span>
      </div>
    </template>
  </div>

  <Sheet v-if="ui.choice" :title="ui.choice.title" :width="460" @close="choose(null)">
    <p v-if="ui.choice.message" class="msg">{{ ui.choice.message }}</p>
    <template #footer>
      <button class="btn" @click="choose(null)">취소</button>
      <button
        v-for="(o, i) in [...ui.choice.options].reverse()"
        :key="o"
        :class="i === ui.choice.options.length - 1 ? 'primary-btn' : 'btn'"
        @click="choose(ui.choice.options.length - 1 - i)"
      >{{ o }}</button>
    </template>
  </Sheet>

  <Sheet v-if="ui.ask" :title="ui.ask.title" :width="440" @close="answer(false)">
    <p v-if="ui.ask.message" class="msg">{{ ui.ask.message }}</p>
    <input
      v-if="ui.ask.value !== undefined"
      ref="input"
      v-model="text"
      class="input wide"
      :placeholder="ui.ask.placeholder"
      spellcheck="false"
      @keydown.enter="answer(true)"
    />
    <label v-if="ui.ask.check" class="chk"><input v-model="checked" type="checkbox" /> {{ ui.ask.check.label }}</label>
    <template #footer>
      <button class="btn" @click="answer(false)">취소</button>
      <button class="primary-btn" :class="{ danger: ui.ask.danger }" @click="answer(true)">{{ ui.ask.ok }}</button>
    </template>
  </Sheet>
</template>

<style scoped>
.ctx {
  position: fixed;
  z-index: 300;
  min-width: 190px;
  padding: 5px;
  border-radius: 9px;
  background: var(--elevated);
  box-shadow: var(--shadow);
  backdrop-filter: blur(20px);
}
.item {
  padding: 5px 10px;
  border-radius: 5px;
  white-space: nowrap;
}
.item:hover:not(.disabled) {
  background: var(--accent);
  color: #fff;
}
.item {
  display: flex;
  align-items: center;
  max-width: 460px;
}
.hint {
  margin-left: 10px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 11.5px;
  opacity: 0.55;
  direction: rtl;
  text-align: left;
}
.chk-col {
  display: inline-block;
  width: 18px;
}
.mhead {
  padding: 4px 10px 2px 28px;
  font-size: 11px;
  color: var(--text-faint);
}
.item.danger {
  color: var(--red);
}
.item.danger:hover {
  color: #fff;
  background: var(--red);
}
.item.disabled {
  color: var(--text-faint);
}
.sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border-strong);
}
.msg {
  margin: 4px 0 12px;
  color: var(--text-dim);
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-all;
}
.wide {
  width: 100%;
  height: 30px;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  color: var(--text-dim);
}
.primary-btn.danger {
  background: var(--red);
}
</style>
