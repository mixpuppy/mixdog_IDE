import { createApp } from 'vue'
import App from './App.vue'
import './styles/global.css'
import './styles/form.css'
import './monaco'
import './commands'

// Monaco rejects pending work with a "Canceled" error when an editor pane closes (split panes,
// closing tabs). It is expected and harmless - keep it out of the console.
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason as { name?: string; message?: string } | undefined
  if (r?.name === 'Canceled' || r?.message === 'Canceled') e.preventDefault()
})

createApp(App).mount('#app')
