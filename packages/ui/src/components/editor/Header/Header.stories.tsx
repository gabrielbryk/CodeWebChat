import { Header } from './Header'
import { useState } from 'react'

export default {
  component: Header
}

export const Default = () => {
  const [active_tab, set_active_tab] = useState<'home' | 'donations' | 'settings'>(
    'home'
  )

  return (
    <Header
      active_tab={active_tab}
      on_home_tab_click={() => set_active_tab('home')}
      on_donations_tab_click={() => set_active_tab('donations')}
      on_settings_tab_click={() => set_active_tab('settings')}
    />
  )
}
